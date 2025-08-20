import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { SendAuthorization } from 'cosmjs-types/cosmos/bank/v1beta1/authz';
import { NibiruTxClient } from '@nibiruchain/nibijs';
import { QueryClient, assertIsDeliverTxSuccess, setupAuthzExtension } from '@cosmjs/stargate';
import { Registry } from '@cosmjs/proto-signing';
import { MsgSend } from 'cosmjs-types/cosmos/bank/v1beta1/tx';
import { MsgExec } from 'cosmjs-types/cosmos/authz/v1beta1/tx';
import { Tendermint37Client } from '@cosmjs/tendermint-rpc';
import { Any } from 'cosmjs-types/google/protobuf/any';
import { MongoClient, ObjectId } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI!;
const MNEMONIC = process.env.GRANTEE_MNEMONIC!;

const registry = new Registry();
registry.register('/cosmos.bank.v1beta1.MsgSend', MsgSend);
registry.register('/cosmos.authz.v1beta1.MsgExec', MsgExec);

async function fetchGrants(): Promise<any[]> {
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    const db = client.db('cosmos');
    const collection = db.collection('cosmos_collection');

    const grants = await collection.find({ chainId: 'cataclysm-1', executed: { $ne: true } }).toArray();
    console.log(`Found ${grants.length} unexecuted grants on Nibiru Network...`);
    return grants;
  } finally {
    await client.close();
  }
}

async function markGrantAsExecuted(grantId: ObjectId): Promise<void> {
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    const db = client.db('cosmos');
    const collection = db.collection('cosmos_collection');

    await collection.updateOne(
      { _id: grantId },
      { $set: { executed: true, executedAt: new Date() } }
    );
    console.log(`Marked grant ${grantId} as executed`);
  } finally {
    await client.close();
  }
}

async function getGranteeWallet(): Promise<DirectSecp256k1HdWallet> {
  if (!MNEMONIC) {
    throw new Error('GRANTEE_MNEMONIC not configured in .env');
  }
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: 'nibi' });
  const accounts = await wallet.getAccounts();
  console.log(`Grantee address: ${accounts[0].address}`);
  return wallet;
}

async function executeAuthz(grant: any): Promise<void> {
  console.log("Executing Grants on Nibiru Network.....");
  const { granter, granteeAddress, rpcUrl, authorizedTokens } = grant;

  if (!rpcUrl) throw new Error('RPC URL not provided in grant');
  if (!granter) throw new Error('Granter address not provided in grant');

  const wallet = await getGranteeWallet();
  const client = await NibiruTxClient.connectWithSigner(rpcUrl, wallet);
  const derivedGrantee = (await wallet.getAccounts())[0].address;

  if (derivedGrantee !== granteeAddress) {
    throw new Error(`Derived grantee address (${derivedGrantee}) does not match DB grantee address (${granteeAddress})`);
  }

  console.log(`Granter: ${granter}`);
  console.log(`Grantee: ${granteeAddress}`);
  console.log(`Recipient: ${granteeAddress}`);
  console.log(`Authorized Tokens: ${authorizedTokens.join(', ')}`);

  const tmClient = await Tendermint37Client.connect(rpcUrl);
  const queryClient = QueryClient.withExtensions(tmClient, setupAuthzExtension);
  const response = await queryClient.authz.grants(granter, granteeAddress, '/cosmos.bank.v1beta1.MsgSend');

  if (!response.grants || response.grants.length === 0) {
    throw new Error('No AuthZ grants found');
  }

  const now = Math.floor(Date.now() / 1000);
  let spendLimits: { denom: string; amount: string }[] = [];
  for (const g of response.grants) {
    const expirationSeconds = g.expiration?.seconds ? Number(g.expiration.seconds) : Infinity;
    if (expirationSeconds > now && g.authorization!.typeUrl === '/cosmos.bank.v1beta1.SendAuthorization') {
      const decodedAuth = SendAuthorization.decode(new Uint8Array(Object.values(g.authorization!.value)));
      spendLimits = decodedAuth.spendLimit.map(coin => ({ denom: coin.denom, amount: coin.amount }));
      break;
    }
  }

  if (spendLimits.length === 0) {
    throw new Error('No valid SendAuthorization grant found');
  }

  const validSpendLimits = spendLimits.filter(limit => authorizedTokens.includes(limit.denom));
  if (validSpendLimits.length === 0) {
    throw new Error('No matching authorized tokens found in the grant');
  }

  const currentBalances = await Promise.all(
    validSpendLimits.map(async (limit) => ({
      denom: limit.denom,
      amount: (await client.getBalance(granter, limit.denom)).amount || '0',
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
    throw new Error('No available balance to send');
  }

  console.log(`Current Balances:`, currentBalances);
  console.log(`Sending:`, sendAmounts);

  const sendMsgValue = MsgSend.fromPartial({
    fromAddress: granter,
    toAddress: granteeAddress,
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

  const result = await client.signAndBroadcast(
    granteeAddress,
    [execMsg],
    'auto',
    `Executing AuthZ send for ${sendAmounts.map(c => `${c.amount} ${c.denom}`).join(', ')}`
  );

  assertIsDeliverTxSuccess(result);
  console.log(`GRANT SUCCESSFUL WITH TRANSACTION HASH: ${result.transactionHash}`);
}

async function main(): Promise<void> {
  console.log("STARTING NIBIRU AUTHZ GRANT MODULE....!!!!!!");

  while (true) {
    try {
      const grants = await fetchGrants();
      if (grants.length === 0) {
        console.log("No unexecuted Nibiru grants found. Waiting...");
        await new Promise(resolve => setTimeout(resolve, 30000));
        continue;
      }

      for (const grant of grants) {
        try {
          await executeAuthz(grant);
          await markGrantAsExecuted(grant._id);
        } catch (error) {
          console.error(`Failed to execute grant for Nibiru: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      console.error("Error in main loop: ", (error as Error).message);
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
  }
}

main()
  .then(() => {
    console.log('Process complete');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });