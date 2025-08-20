"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const stargate_1 = require("@cosmjs/stargate");
const proto_signing_1 = require("@cosmjs/proto-signing");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const RPC_URL = 'https://cosmos-rpc.publicnode.com:443';
const getSignerFromKey = async () => {
    const privateKeyHex = process.env.GRANTER_PRIVATE_KEY;
    // Convert hex string to Uint8Array
    const privateKeyBytes = new Uint8Array(Buffer.from(privateKeyHex, 'hex'));
    return proto_signing_1.DirectSecp256k1Wallet.fromKey(privateKeyBytes, "cosmos"); // Add prefix if needed
};
const runAll = async () => {
    console.log("Starting....");
    const signer = await getSignerFromKey();
    const accounts = await signer.getAccounts();
    console.log("Accounts:", accounts);
    const address = accounts[0].address;
    console.log("Address from the signer: ", address);
    // Set gas price when connecting the signing client
    const gasPrice = stargate_1.GasPrice.fromString("0.025uatom"); // Use chihuahua denom, not osmo
    const signingClient = await stargate_1.SigningStargateClient.connectWithSigner(RPC_URL, signer, {
        gasPrice: gasPrice
    });
    console.log(`With client, chain id:`, await signingClient.getChainId(), `, height:`, await signingClient.getHeight());
    // Get balance in correct denom for chihuahua chain
    const balance = await signingClient.getBalance(address, 'uatom');
    console.log(balance);
    while (true) {
        try {
            const result = await signingClient.signAndBroadcast(address, [
                {
                    typeUrl: '/cosmos.bank.v1beta1.MsgSend',
                    value: {
                        fromAddress: address,
                        toAddress: process.env.GRANTEE_RECIPIENT_ADDRESS,
                        amount: [
                            { denom: balance.denom, amount: '1000' }
                        ],
                    },
                },
                //message 2
            ], 
            //fee
            'auto');
            console.log("This is the result of the Tx: ", result.gasUsed, result.transactionHash);
        }
        catch (error) {
            console.error("This transaction failed: ", error);
        }
    }
};
runAll().catch(console.error);
