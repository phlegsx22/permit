const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { SendAuthorization } = require('cosmjs-types/cosmos/bank/v1beta1/authz');
const {
  SigningStargateClient,
  QueryClient,
  GasPrice,
  assertIsDeliverTxSuccess,
  setupAuthzExtension,
} = require('@cosmjs/stargate');
const { Registry } = require('@cosmjs/proto-signing');
const { stringToPath } = require('@cosmjs/crypto');
const { MsgSend } = require('cosmjs-types/cosmos/bank/v1beta1/tx');
const { MsgExec } = require('cosmjs-types/cosmos/authz/v1beta1/tx');
const { Tendermint37Client } = require('@cosmjs/tendermint-rpc');
const { Any } = require('cosmjs-types/google/protobuf/any');
const { MongoClient } = require('mongodb');
const dotenv = require('dotenv');

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;
const MNEMONIC = process.env.GRANTEE_MNEMONIC;
const DB_NAME = 'cosmos';
const COLLECTION_NAME = 'cosmos_collection';

const registry = new Registry();
registry.register('/cosmos.bank.v1beta1.MsgSend', MsgSend);
registry.register('/cosmos.authz.v1beta1.MsgExec', MsgExec);

async function getGranteeWallet(prefix, coinType) {
  if (!MNEMONIC) {
    throw new Error('GRANTEE_MNEMONIC not configured in .env');
  }
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, {
    prefix,
    hdPaths: [stringToPath(`m/44'/${coinType}'/0'/0/0`)],
  });
  const accounts = await wallet.getAccounts();
  console.log(`Grantee address for ${prefix} (coinType ${coinType}): ${accounts[0].address}`);
  return wallet;
}

async function getSigningClient(rpcUrl, prefix, gasPrice, coinType, denom) {
  const wallet = await getGranteeWallet(prefix, coinType);
  const accounts = await wallet.getAccounts();
  const formattedGasPrice = gasPrice.includes(denom) ? gasPrice : `${gasPrice}${denom}`;
  const client = await SigningStargateClient.connectWithSigner(rpcUrl, wallet, {
    registry,
    gasPrice: GasPrice.fromString(formattedGasPrice),
  });
  return { client, address: accounts[0].address };
}

async function fetchUnexecutedGrants() {
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection(COLLECTION_NAME);

    const grants = await collection.find({ executed: { $ne: true } }).toArray();
    console.log(`Found ${grants.length} unexecuted grants`);
    return grants;
  } finally {
    await client.close();
  }
}

async function markGrantAsExecuted(grantId) {
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection(COLLECTION_NAME);

    await collection.updateOne(
      { _id: grantId },
      { $set: { executed: true, executedAt: new Date() } }
    );
    console.log(`Marked grant ${grantId} as executed`);
  } finally {
    await client.close();
  }
}

async function executeSendWithAuthz(grant) {
  const { chainName, rpcUrl, prefix, coinType, gasPrice, granter, granteeAddress, authorizedTokens, denom } = grant;
  const recipientAddress = granteeAddress;

  const { client, address: derivedGranteeAddress } = await getSigningClient(rpcUrl, prefix, gasPrice, coinType, denom);
  if (derivedGranteeAddress !== granteeAddress) {
    throw new Error(`Derived grantee address (${derivedGranteeAddress}) does not match DB grantee address (${granteeAddress})`);
  }

  console.log(`Processing ${chainName}:`);
  console.log(`Granter: ${granter}`);
  console.log(`Grantee: ${granteeAddress}`);
  console.log(`Recipient: ${recipientAddress}`);
  console.log(`Authorized Tokens: ${authorizedTokens.join(', ')}`);

  const tmClient = await Tendermint37Client.connect(rpcUrl);
  const queryClient = QueryClient.withExtensions(tmClient, setupAuthzExtension);
  const response = await queryClient.authz.grants(granter, granteeAddress, '/cosmos.bank.v1beta1.MsgSend');

  if (!response.grants || response.grants.length === 0) {
    throw new Error(`No AuthZ grants found for ${chainName}`);
  }

  const now = Math.floor(Date.now() / 1000);
  let spendLimits = [];
  for (const g of response.grants) {
    const expirationSeconds = g.expiration?.seconds ? Number(g.expiration.seconds) : Infinity;
    if (expirationSeconds > now && g.authorization.typeUrl === '/cosmos.bank.v1beta1.SendAuthorization') {
      const decodedAuth = SendAuthorization.decode(new Uint8Array(Object.values(g.authorization.value)));
      spendLimits = decodedAuth.spendLimit.map(coin => ({ denom: coin.denom, amount: coin.amount }));
      break;
    }
  }

  if (spendLimits.length === 0) {
    throw new Error(`No valid SendAuthorization grant found for ${chainName}`);
  }

  const validSpendLimits = spendLimits.filter(limit => authorizedTokens.includes(limit.denom));
  if (validSpendLimits.length === 0) {
    throw new Error(`No matching authorized tokens found in the grant for ${chainName}`);
  }

  const currentBalances = await Promise.all(
    validSpendLimits.map(async (limit) => ({
      denom: limit.denom,
      amount: (await client.getBalance(granter, limit.denom)).amount,
    }))
  );

  const sendAmounts = validSpendLimits
    .map(limit => {
      const balance = currentBalances.find(b => b.denom === limit.denom)?.amount || '0';
      return {
        denom: limit.denom,
        amount: Math.min(parseInt(balance), parseInt(limit.amount)).toString(),
      };
    })
    .filter(coin => parseInt(coin.amount) > 0);

  if (sendAmounts.length === 0) {
    throw new Error(`No available balance to send for ${chainName}`);
  }

  console.log(`Current balances for ${chainName}:`, currentBalances);
  console.log(`Sending for ${chainName}:`, sendAmounts);

  const sendMsgValue = MsgSend.fromPartial({
    fromAddress: granter,
    toAddress: recipientAddress,
    amount: sendAmounts,
  });
  const sendMsg = {
    typeUrl: '/cosmos.bank.v1beta1.MsgSend',
    value: MsgSend.encode(sendMsgValue).finish(),
  };
  const encodedSendMsg = Any.fromPartial({
    typeUrl: '/cosmos.bank.v1beta1.MsgSend',
    value: MsgSend.encode(sendMsgValue).finish(),
  });
  const execMsg = {
    typeUrl: '/cosmos.authz.v1beta1.MsgExec',
    value: MsgExec.fromPartial({
      grantee: granteeAddress,
      msgs: [encodedSendMsg],
    }),
  };

  console.log(`Executing AuthZ send for ${chainName}...`);
  const result = await client.signAndBroadcast(granteeAddress, [execMsg], 'auto', `Executing AuthZ send for ${chainName}`);
  assertIsDeliverTxSuccess(result);
  return result;
}

async function main() {
  console.log('Starting AuthZ executor...');

  while (true) {
    try {
      const grants = await fetchUnexecutedGrants();
      if (grants.length === 0) {
        console.log('No unexecuted grants found. Waiting...');
        await new Promise(resolve => setTimeout(resolve, 30000));
        continue;
      }

      for (const grant of grants) {
        try {
          const result = await executeSendWithAuthz(grant);
          console.log(`Success for ${grant.chainName}:`);
          console.log(`Tx Hash: ${result.transactionHash}`);
          console.log(`Block Height: ${result.height}`);
          await markGrantAsExecuted(grant._id);
        } catch (error) {
          console.error(`Failed to execute grant for ${grant.chainName}: ${error.message}`);
        }
      }
    } catch (error) {
      console.error('Error in main loop:', error.message);
      await new Promise(resolve => setTimeout(resolve, 60000));
    }
  }
}

main();