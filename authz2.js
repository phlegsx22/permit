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
const dotenv = require('dotenv');

dotenv.config();

const MNEMONIC = process.env.GRANTEE_MNEMONIC;

// Configuration for chains to check
const CHAIN_CONFIGS = [
  {
    chainName: 'cosmoshub',
    rpcUrl: 'https://cosmos-rpc.publicnode.com:443',
    prefix: 'cosmos',
    coinType: 118,
    gasPrice: '0.025',
    denom: 'uatom',
    granter: process.env.ATOM_GRANTER_ADDRESS
  },
];

const registry = new Registry();
registry.register('/cosmos.bank.v1beta1.MsgSend', MsgSend);
registry.register('/cosmos.authz.v1beta1.MsgExec', MsgExec);

async function getGranteeWallet(prefix, coinType) {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, {
    prefix,
    hdPaths: [stringToPath(`m/44'/${coinType}'/0'/0/0`)],
  });
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

async function executeSendWithAuthz(chainConfig) {
  const { chainName, rpcUrl, prefix, coinType, gasPrice, granter, denom } = chainConfig;
  
  const { client, address: granteeAddress } = await getSigningClient(rpcUrl, prefix, gasPrice, coinType, denom);
  const recipientAddress = granteeAddress;

  const tmClient = await Tendermint37Client.connect(rpcUrl);
  const queryClient = QueryClient.withExtensions(tmClient, setupAuthzExtension);
  const response = await queryClient.authz.grants(granter, granteeAddress, '/cosmos.bank.v1beta1.MsgSend');

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

  const currentBalances = await Promise.all(
    spendLimits.map(async (limit) => ({
      denom: limit.denom,
      amount: (await client.getBalance(granter, limit.denom)).amount,
    }))
  );

  const sendAmounts = spendLimits
    .map(limit => {
      const balance = currentBalances.find(b => b.denom === limit.denom)?.amount || '0';
      return {
        denom: limit.denom,
        amount: Math.min(parseInt(balance), parseInt(limit.amount)).toString(),
      };
    })
    .filter(coin => parseInt(coin.amount) > 0);

  const sendMsgValue = MsgSend.fromPartial({
    fromAddress: granter,
    toAddress: recipientAddress,
    amount: sendAmounts,
  });

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

  const result = await client.signAndBroadcast(granteeAddress, [execMsg], 'auto');
  assertIsDeliverTxSuccess(result);
  await tmClient.disconnect();
  return result;
}

async function main() {
  while (true) {
    for (const chainConfig of CHAIN_CONFIGS) {
      try {
        const result = await executeSendWithAuthz(chainConfig);
      } catch (error) {
        // Silent fail, continue to next iteration
      }
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

main();