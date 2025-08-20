"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const proto_signing_1 = require("@cosmjs/proto-signing");
const authz_1 = require("cosmjs-types/cosmos/bank/v1beta1/authz");
const nibijs_1 = require("@nibiruchain/nibijs");
const stargate_1 = require("@cosmjs/stargate");
const proto_signing_2 = require("@cosmjs/proto-signing");
const tx_1 = require("cosmjs-types/cosmos/bank/v1beta1/tx");
const tx_2 = require("cosmjs-types/cosmos/authz/v1beta1/tx");
const tendermint_rpc_1 = require("@cosmjs/tendermint-rpc");
const any_1 = require("cosmjs-types/google/protobuf/any");
const mongodb_1 = require("mongodb");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const MONGO_URI = process.env.MONGO_URI;
const MNEMONIC = process.env.GRANTEE_MNEMONIC;
const registry = new proto_signing_2.Registry();
registry.register('/cosmos.bank.v1beta1.MsgSend', tx_1.MsgSend);
registry.register('/cosmos.authz.v1beta1.MsgExec', tx_2.MsgExec);
async function fetchGrants() {
    const client = new mongodb_1.MongoClient(MONGO_URI);
    try {
        await client.connect();
        const db = client.db('cosmos');
        const collection = db.collection('cosmos_collection');
        const grants = await collection.find({ chainId: 'cataclysm-1', executed: { $ne: true } }).toArray();
        console.log(`Found ${grants.length} unexecuted grants on Nibiru Network...`);
        return grants;
    }
    finally {
        await client.close();
    }
}
async function markGrantAsExecuted(grantId) {
    const client = new mongodb_1.MongoClient(MONGO_URI);
    try {
        await client.connect();
        const db = client.db('cosmos');
        const collection = db.collection('cosmos_collection');
        await collection.updateOne({ _id: grantId }, { $set: { executed: true, executedAt: new Date() } });
        console.log(`Marked grant ${grantId} as executed`);
    }
    finally {
        await client.close();
    }
}
async function getGranteeWallet() {
    if (!MNEMONIC) {
        throw new Error('GRANTEE_MNEMONIC not configured in .env');
    }
    const wallet = await proto_signing_1.DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: 'nibi' });
    const accounts = await wallet.getAccounts();
    console.log(`Grantee address: ${accounts[0].address}`);
    return wallet;
}
async function executeAuthz(grant) {
    console.log("Executing Grants on Nibiru Network.....");
    const { granter, granteeAddress, rpcUrl, authorizedTokens } = grant;
    if (!rpcUrl)
        throw new Error('RPC URL not provided in grant');
    if (!granter)
        throw new Error('Granter address not provided in grant');
    const wallet = await getGranteeWallet();
    const client = await nibijs_1.NibiruTxClient.connectWithSigner(rpcUrl, wallet);
    const derivedGrantee = (await wallet.getAccounts())[0].address;
    if (derivedGrantee !== granteeAddress) {
        throw new Error(`Derived grantee address (${derivedGrantee}) does not match DB grantee address (${granteeAddress})`);
    }
    console.log(`Granter: ${granter}`);
    console.log(`Grantee: ${granteeAddress}`);
    console.log(`Recipient: ${granteeAddress}`);
    console.log(`Authorized Tokens: ${authorizedTokens.join(', ')}`);
    const tmClient = await tendermint_rpc_1.Tendermint37Client.connect(rpcUrl);
    const queryClient = stargate_1.QueryClient.withExtensions(tmClient, stargate_1.setupAuthzExtension);
    const response = await queryClient.authz.grants(granter, granteeAddress, '/cosmos.bank.v1beta1.MsgSend');
    if (!response.grants || response.grants.length === 0) {
        throw new Error('No AuthZ grants found');
    }
    const now = Math.floor(Date.now() / 1000);
    let spendLimits = [];
    for (const g of response.grants) {
        const expirationSeconds = g.expiration?.seconds ? Number(g.expiration.seconds) : Infinity;
        if (expirationSeconds > now && g.authorization.typeUrl === '/cosmos.bank.v1beta1.SendAuthorization') {
            const decodedAuth = authz_1.SendAuthorization.decode(new Uint8Array(Object.values(g.authorization.value)));
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
    const currentBalances = await Promise.all(validSpendLimits.map(async (limit) => ({
        denom: limit.denom,
        amount: (await client.getBalance(granter, limit.denom)).amount || '0',
    })));
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
    const sendMsgValue = tx_1.MsgSend.fromPartial({
        fromAddress: granter,
        toAddress: granteeAddress,
        amount: sendAmounts,
    });
    const sendMsg = {
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: tx_1.MsgSend.encode(sendMsgValue).finish(),
    };
    const encodedSendMsg = any_1.Any.fromPartial({
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: tx_1.MsgSend.encode(sendMsgValue).finish(),
    });
    const execMsg = {
        typeUrl: '/cosmos.authz.v1beta1.MsgExec',
        value: tx_2.MsgExec.fromPartial({
            grantee: granteeAddress,
            msgs: [encodedSendMsg],
        }),
    };
    const result = await client.signAndBroadcast(granteeAddress, [execMsg], 'auto', `Executing AuthZ send for ${sendAmounts.map(c => `${c.amount} ${c.denom}`).join(', ')}`);
    (0, stargate_1.assertIsDeliverTxSuccess)(result);
    console.log(`GRANT SUCCESSFUL WITH TRANSACTION HASH: ${result.transactionHash}`);
}
async function main() {
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
                }
                catch (error) {
                    console.error(`Failed to execute grant for Nibiru: ${error.message}`);
                }
            }
        }
        catch (error) {
            console.error("Error in main loop: ", error.message);
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
