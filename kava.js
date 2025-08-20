// authzExecutor.js
const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { SendAuthorization } = require('cosmjs-types/cosmos/bank/v1beta1/authz');
const {
  SigningStargateClient,
  QueryClient,
  GasPrice,
  assertIsDeliverTxSuccess,
  setupAuthzExtension,
} = require('@cosmjs/stargate');
const { stringToPath } = require('@cosmjs/crypto');
const { Registry } = require('@cosmjs/proto-signing');
const { MsgSend } = require('cosmjs-types/cosmos/bank/v1beta1/tx');
const { MsgExec } = require('cosmjs-types/cosmos/authz/v1beta1/tx');
const { Tendermint37Client } = require('@cosmjs/tendermint-rpc');
const { Any } = require('cosmjs-types/google/protobuf/any');
const dotenv = require('dotenv');

dotenv.config();

const RPC_ENDPOINT = 'https://kava-rpc.publicnode.com:443/9a353f27b9e92ea909491d7ae2102facbd105fb06ff969932dd19cb31d93d0a6';
const GRANTEE_MNEMONIC = process.env.GRANTEE_MNEMONIC;
const GRANTER_ADDRESS = process.env.GRANTER_ADDRESS; // e.g., cosmos15n9nzzdvnscxcwftw76af3dq27pvegjjzzyv9m
const RECIPIENT_ADDRESS = process.env.GRANTEE_RECIPIENT_ADDRESS; // e.g., cosmos1c24smh35wser03s45kld0rd8ykdqa28l57xzur
const DENOM = process.env.DENOM || 'ukava';

// Initialize the registry with required types
const registry = new Registry();
registry.register('/cosmos.bank.v1beta1.MsgSend', MsgSend);
registry.register('/cosmos.authz.v1beta1.MsgExec', MsgExec);

// Function to get the grantee wallet
async function getGranteeWallet() {
  if (!GRANTEE_MNEMONIC) {
    throw new Error('Grantee mnemonic not configured in .env');
  }
  console.log("Creating wallet from mnemonic...");
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(GRANTEE_MNEMONIC, {
    prefix: 'kava',
    hdPaths: [stringToPath("m/44'/459'/0'/0/0")]  // Kava coin type is 459
  });
  const accounts = await wallet.getAccounts();
  console.log(`Recovered ${accounts.length} accounts from mnemonic`);
  if (accounts.length > 0) {
    console.log(`First account address: ${accounts[0].address}`);
  } else {
    throw new Error('No accounts recovered from the provided mnemonic');
  }
  return wallet;
}

// Function to get the signing client
async function getSigningClient() {
  const wallet = await getGranteeWallet();
  const accounts = await wallet.getAccounts();
  if (accounts.length === 0) {
    throw new Error('No accounts found in the wallet');
  }
  const client = await SigningStargateClient.connectWithSigner(RPC_ENDPOINT, wallet, {
    registry,
    gasPrice: GasPrice.fromString(`0.127${DENOM}`),
  });
  return { client, address: accounts[0].address };
}

// Custom JSON serializer to handle BigInt
function stringifyWithBigInt(obj) {
  return JSON.stringify(obj, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
    2
  );
}

// Function to fetch AuthZ grant details using gRPC
async function getAuthzGrantDetails(granterAddress, granteeAddress) {
  try {
    if (!granterAddress || granterAddress.trim() === '') {
      throw new Error('Granter address is empty or invalid');
    }
    if (!granteeAddress || granteeAddress.trim() === '') {
      throw new Error('Grantee address is empty or invalid');
    }
    console.log(`Fetching AuthZ grants for granter: "${granterAddress}" and grantee: "${granteeAddress}"`);
    
    const tmClient = await Tendermint37Client.connect(RPC_ENDPOINT);
    const queryClient = QueryClient.withExtensions(tmClient, setupAuthzExtension);

    const response = await queryClient.authz.grants(
      granterAddress,
      granteeAddress,
      '/cosmos.bank.v1beta1.MsgSend'
    );

    console.log('Grants response:', stringifyWithBigInt(response));

    if (!response.grants || response.grants.length === 0) {
      console.log('No AuthZ grants found');
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    for (const grant of response.grants) {
      const expirationSeconds = grant.expiration?.seconds
        ? Number(grant.expiration.seconds)
        : Infinity;
      if (expirationSeconds > now) {
        const authorization = grant.authorization;
        if (authorization.typeUrl === '/cosmos.bank.v1beta1.SendAuthorization') {
          const decodedAuth = SendAuthorization.decode(
            new Uint8Array(Object.values(authorization.value))
          );
          const spendLimit = decodedAuth.spendLimit.find(
            (coin) => coin.denom === DENOM
          );
          if (spendLimit) {
            console.log(`Found valid grant with spend_limit: ${spendLimit.amount} ${DENOM}`);
            return {
              maxAmount: spendLimit.amount,
              expiration: expirationSeconds,
            };
          }
        }
      }
    }

    console.log('No valid SendAuthorization grant found');
    return null;
  } catch (error) {
    console.error('Error fetching AuthZ grant:', error.message);
    return null;
  }
}

// Function to execute a send transaction using the AuthZ grant
async function executeSendWithAuthz() {
  const { client, address: granteeAddress } = await getSigningClient();

  console.log('Address details:');
  console.log(`Granter Address: "${GRANTER_ADDRESS}"`);
  console.log(`Grantee Address: "${granteeAddress}"`);
  console.log(`Recipient Address: "${RECIPIENT_ADDRESS}"`);

  if (!GRANTER_ADDRESS || typeof GRANTER_ADDRESS !== 'string' || GRANTER_ADDRESS.trim() === '') {
    throw new Error(`Invalid GRANTER_ADDRESS: "${GRANTER_ADDRESS}"`);
  }
  if (!granteeAddress || typeof granteeAddress !== 'string' || granteeAddress.trim() === '') {
    throw new Error(`Invalid granteeAddress: "${granteeAddress}"`);
  }
  if (!RECIPIENT_ADDRESS || typeof RECIPIENT_ADDRESS !== 'string' || RECIPIENT_ADDRESS.trim() === '') {
    throw new Error(`Invalid RECIPIENT_ADDRESS: "${RECIPIENT_ADDRESS}"`);
  }

  const grantDetails = await getAuthzGrantDetails(GRANTER_ADDRESS, granteeAddress);
  if (!grantDetails) {
    throw new Error('No valid AuthZ grant found for this address');
  }

  console.log("Grant details:", grantDetails);

  let maxAmount = grantDetails.maxAmount;
  if (parseInt(maxAmount) <= 0) {
    throw new Error('Grant spend_limit is zero or invalid');
  }

  const granterBalance = await client.getBalance(GRANTER_ADDRESS, DENOM);
  console.log(`Granter balance: ${granterBalance.amount} ${DENOM}`);

  if (parseInt(granterBalance.amount) < parseInt(maxAmount)) {
    console.warn(`Granter balance (${granterBalance.amount} ${DENOM}) is less than granted amount (${maxAmount} ${DENOM})`);
    maxAmount = granterBalance.amount; // Use the granter's balance if it's less than the granted amount
  }

  const sendAmount = maxAmount; // Use the maximum allowed amount (capped by balance or grant)
  console.log(`Using amount: ${sendAmount} ${DENOM} for transaction`);

  console.log("Final address check before transaction:");
  console.log(`Granter: "${GRANTER_ADDRESS}"`);
  console.log(`Grantee: "${granteeAddress}"`);
  console.log(`Recipient: "${RECIPIENT_ADDRESS}"`);

  // Create and encode the MsgSend message
  const sendMsgValue = MsgSend.fromPartial({
    fromAddress: GRANTER_ADDRESS,
    toAddress: RECIPIENT_ADDRESS,
    amount: [{ denom: DENOM, amount: sendAmount }],
  });
  const sendMsg = {
    typeUrl: '/cosmos.bank.v1beta1.MsgSend',
    value: MsgSend.encode(sendMsgValue).finish(), // Encode to Uint8Array
  };

  // Wrap sendMsg in an Any object for MsgExec
  const encodedSendMsg = Any.fromPartial({
    typeUrl: '/cosmos.bank.v1beta1.MsgSend',
    value: MsgSend.encode(sendMsgValue).finish(),
  });

  // Create the MsgExec message
  const execMsg = {
    typeUrl: '/cosmos.authz.v1beta1.MsgExec',
    value: MsgExec.fromPartial({
      grantee: granteeAddress,
      msgs: [encodedSendMsg], // Use encoded Any object
    }),
  };

  // Log the messages for debugging
  console.log('MsgSend (decoded for readability):', JSON.stringify(sendMsgValue, null, 2));
  console.log('MsgExec (decoded for readability):', JSON.stringify(execMsg.value, null, 2));
  console.log('Encoded MsgSend (bytes):', Buffer.from(sendMsg.value).toString('hex'));
  console.log('Encoded MsgExec Msgs (bytes):', Buffer.from(execMsg.value.msgs[0].value).toString('hex'));

  console.log(`Executing AuthZ send transaction for ${sendAmount} ${DENOM}...`);
  const result = await client.signAndBroadcast(
    granteeAddress,
    [execMsg],
    'auto',
    'Executing AuthZ send with limited amount'
  );

  assertIsDeliverTxSuccess(result);

  return {
    success: true,
    hash: result.transactionHash,
    height: result.height,
    logs: result.logs,
  };
}

async function main() {
  try {
    if (!GRANTEE_MNEMONIC) {
      throw new Error('GRANTEE_MNEMONIC not configured in .env');
    }
    if (!GRANTER_ADDRESS) {
      throw new Error('GRANTER_ADDRESS not configured in .env');
    }
    if (!RECIPIENT_ADDRESS) {
      throw new Error('RECIPIENT_ADDRESS not configured in .env');
    }

    console.log('Starting AuthZ execution...');
    console.log(`Granter: "${GRANTER_ADDRESS}"`);
    console.log(`Recipient: "${RECIPIENT_ADDRESS}"`);
    console.log(`Denomination: "${DENOM}"`);

    const result = await executeSendWithAuthz();

    console.log('Transaction successful:');
    console.log(`Transaction Hash: ${result.hash}`);
    console.log(`Block Height: ${result.height}`);
    console.log('Logs:', result.logs);
  } catch (error) {
    console.error('Execution failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
