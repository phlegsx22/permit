import { MsgAuthzExec, PrivateKey, MsgBroadcasterWithPk, MsgSend, ChainGrpcBankApi } from '@injectivelabs/sdk-ts';
import { BigNumberInBase } from '@injectivelabs/utils';
import { getNetworkEndpoints, Network } from '@injectivelabs/networks';
import { MongoClient, ObjectId } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const seed = process.env.GRANTEE_MNEMONIC!;
const MONGO_URI = process.env.MONGO_URI!;

async function fetchGrants() {
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    const db = client.db('cosmos');
    const cosmosCollection = db.collection('cosmos_collection');

    const grants = await cosmosCollection.find({ chainId: 'injective-1', executed: { $ne: true } }).toArray();
    console.log(`Found ${grants.length} unexecuted grants on Injective Network...`);
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

async function executeAuthz(grant: any): Promise<void> {
  console.log("Executing Grants on Injective Network.....");
  const { granter, granteeAddress, authorizedTokens } = grant;
  const privateKey = PrivateKey.fromMnemonic(seed);
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
    const endpoints = getNetworkEndpoints(Network.Mainnet);
    const bankClient = new ChainGrpcBankApi(endpoints.grpc);

    // Fetch balances for all authorized tokens
    const balances = await Promise.all(
      authorizedTokens.map(async (denom: string) => {
        const balance = await bankClient.fetchBalance({ accountAddress: granter, denom });
        return {
          denom,
          amount: new BigNumberInBase(balance.amount).toFixed(),
        };
      })
    );

    const sendAmounts = balances.filter(b => parseInt(b.amount) > 0);
    if (sendAmounts.length === 0) {
      throw new Error("No non-zero balances available to send");
    }

    console.log('Sending:', sendAmounts);

    // Create MsgSend for each token
    const msgSends = sendAmounts.map((coin: { denom: string; amount: string }) =>
      MsgSend.fromJSON({
        amount: {
          denom: coin.denom,
          amount: coin.amount,
        },
        srcInjectiveAddress: granter,
        dstInjectiveAddress: granteeAddress, // Send to grantee
      })
    );

    const msg = MsgAuthzExec.fromJSON({
      msgs: msgSends,
      grantee: granteeAddress,
    });

    const broadcaster = new MsgBroadcasterWithPk({
      privateKey: privateKeyHex,
      network: Network.Mainnet,
    });

    const result = await broadcaster.broadcast({ msgs: msg });
    console.log("GRANT SUCCESSFUL WITH TRANSACTION HASH:", result.txHash);
  } catch (error) {
    console.error("Could not execute authz. This error is at execute authz level:", error);
    throw error;
  }
}

async function main(): Promise<void> {
  console.log("STARTING INJECTIVE AUTHZ GRANT MODULE....!!!!!!");

  while (true) {
    try {
      const grants = await fetchGrants();
      if (grants?.length === 0) {
        console.log("No unexecuted grants found. Waiting...");
        await new Promise(resolve => setTimeout(resolve, 30000));
        continue;
      }

      for (const grant of grants!) {
        try {
          await executeAuthz(grant);
          await markGrantAsExecuted(grant._id);
        } catch (error) {
          console.error("Failed to execute grant for Injective:", error);
        }
      }
    } catch (error) {
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