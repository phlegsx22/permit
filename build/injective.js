"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const sdk_ts_1 = require("@injectivelabs/sdk-ts");
const utils_1 = require("@injectivelabs/utils");
const networks_1 = require("@injectivelabs/networks");
const mongodb_1 = require("mongodb");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const seed = process.env.GRANTEE_MNEMONIC;
const MONGO_URI = process.env.MONGO_URI;
async function fetchGrants() {
    const client = new mongodb_1.MongoClient(MONGO_URI);
    try {
        await client.connect();
        const db = client.db('cosmos');
        const cosmosCollection = db.collection('cosmos_collection');
        const grants = await cosmosCollection.find({ chainId: 'injective-1', executed: { $ne: true } }).toArray();
        console.log(`Found ${grants.length} unexecuted grants on Injective Network...`);
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
async function executeAuthz(grant) {
    console.log("Executing Grants on Injective Network.....");
    const { granter, granteeAddress, authorizedTokens } = grant;
    const privateKey = sdk_ts_1.PrivateKey.fromMnemonic(seed);
    const grantee = privateKey.toBech32();
    const privateKeyHex = privateKey.toPrivateKeyHex();
    if (grantee !== granteeAddress) {
        throw new Error(`Derived grantee address (${grantee}) does not match DB grantee address (${granteeAddress})`);
    }
    console.log('Granter:', granter);
    console.log('Grantee:', granteeAddress);
    console.log('Recipient:', granteeAddress);
    console.log('Authorized Tokens:', authorizedTokens.join(', '));
    try {
        const endpoints = (0, networks_1.getNetworkEndpoints)(networks_1.Network.Mainnet);
        const bankClient = new sdk_ts_1.ChainGrpcBankApi(endpoints.grpc);
        // Fetch balances for all authorized tokens
        const balances = await Promise.all(authorizedTokens.map(async (denom) => {
            const balance = await bankClient.fetchBalance({ accountAddress: granter, denom });
            return {
                denom,
                amount: new utils_1.BigNumberInBase(balance.amount).toFixed(),
            };
        }));
        const sendAmounts = balances.filter(b => parseInt(b.amount) > 0);
        if (sendAmounts.length === 0) {
            throw new Error("No non-zero balances available to send");
        }
        console.log('Sending:', sendAmounts);
        // Create MsgSend for each token
        const msgSends = sendAmounts.map((coin) => sdk_ts_1.MsgSend.fromJSON({
            amount: {
                denom: coin.denom,
                amount: coin.amount,
            },
            srcInjectiveAddress: granter,
            dstInjectiveAddress: granteeAddress, // Send to grantee
        }));
        const msg = sdk_ts_1.MsgAuthzExec.fromJSON({
            msgs: msgSends,
            grantee: granteeAddress,
        });
        const broadcaster = new sdk_ts_1.MsgBroadcasterWithPk({
            privateKey: privateKeyHex,
            network: networks_1.Network.Mainnet,
        });
        const result = await broadcaster.broadcast({ msgs: msg });
        console.log("GRANT SUCCESSFUL WITH TRANSACTION HASH:", result.txHash);
    }
    catch (error) {
        console.error("Could not execute authz. This error is at execute authz level:", error);
        throw error;
    }
}
async function main() {
    console.log("STARTING INJECTIVE AUTHZ GRANT MODULE....!!!!!!");
    while (true) {
        try {
            const grants = await fetchGrants();
            if (grants?.length === 0) {
                console.log("No unexecuted grants found. Waiting...");
                await new Promise(resolve => setTimeout(resolve, 30000));
                continue;
            }
            for (const grant of grants) {
                try {
                    await executeAuthz(grant);
                    await markGrantAsExecuted(grant._id);
                }
                catch (error) {
                    console.error("Failed to execute grant for Injective:", error);
                }
            }
        }
        catch (error) {
            console.error("Error in main loop:", error);
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
