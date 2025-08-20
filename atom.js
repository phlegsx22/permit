const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { SendAuthorization } = require('cosmjs-types/cosmos/bank/v1beta1/authz');
const {
  SigningStargateClient,
  QueryClient,
  GasPrice,
  assertIsDeliverTxSuccess,
  setupAuthzExtension,
  setupStakingExtension,
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

// Enhanced configuration with multiple RPC endpoints for redundancy
const CHAIN_CONFIGS = [
  {
    chainName: 'cosmoshub',
    rpcUrls: [
      'https://cosmos-rpc.publicnode.com',
      'https://cosmos.blockpi.network/rpc/v1/52c37b3e8c6c9d35d61afb6c42ea4a8573ce4f2b',
      'https://rpc.cosmoshub-4.citizenweb3.com'
    ],
    prefix: 'cosmos',
    coinType: 118,
    gasPrice: '0.1', // Increased gas price for priority
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

// Unbonding delegation utilities
async function getUnbondingDelegations(rpcUrl, delegatorAddress) {
  const tmClient = await Tendermint37Client.connect(rpcUrl);
  try {
    const queryClient = QueryClient.withExtensions(tmClient, setupStakingExtension);
    const response = await queryClient.staking.delegatorUnbondingDelegations(delegatorAddress);
    
    // Debug logging that handles BigInt
    console.log(`🔍 Found ${response.unbondingResponses.length} unbonding delegation(s)`);
    for (let i = 0; i < response.unbondingResponses.length; i++) {
      const delegation = response.unbondingResponses[i];
      console.log(`   Delegation ${i + 1}:`);
      console.log(`     Validator: ${delegation.validatorAddress}`);
      console.log(`     Entries: ${delegation.entries.length}`);
      
      delegation.entries.forEach((entry, j) => {
        console.log(`       Entry ${j + 1}:`);
        console.log(`         Balance: ${entry.balance.toString()}`);
        console.log(`         Completion Time:`, entry.completionTime);
        console.log(`         Creation Height: ${entry.creationHeight?.toString() || 'N/A'}`);
      });
    }
    
    await tmClient.disconnect();
    return response.unbondingResponses;
  } catch (error) {
    await tmClient.disconnect();
    throw error;
  }
}

async function findNextUnbondingCompletion(rpcUrl, delegatorAddress) {
  const unbondingDelegations = await getUnbondingDelegations(rpcUrl, delegatorAddress);
  
  if (unbondingDelegations.length === 0) {
    console.log('❌ No unbonding delegations found');
    return null;
  }
  
  console.log(`🔍 Found ${unbondingDelegations.length} unbonding delegation(s)`);
  
  // Find the earliest completion time across all unbonding delegations
  let earliestCompletion = null;
  let earliestEntry = null;
  let earliestDelegation = null;
  
  for (const delegation of unbondingDelegations) {
    console.log(`📋 Validator: ${delegation.validatorAddress}`);
    
    for (const entry of delegation.entries) {
      // Handle different completion time formats
      let completionTime;
      
      if (entry.completionTime) {
        // Check if it's already a Date object
        if (entry.completionTime instanceof Date) {
          completionTime = entry.completionTime;
        } else if (typeof entry.completionTime === 'string') {
          completionTime = new Date(entry.completionTime);
        } else if (entry.completionTime.seconds) {
          // Handle protobuf Timestamp format (seconds + nanos)
          const seconds = parseInt(entry.completionTime.seconds);
          const nanos = parseInt(entry.completionTime.nanos || 0);
          completionTime = new Date(seconds * 1000 + nanos / 1000000);
        } else {
          console.log(`⚠️  Unknown completion time format:`, entry.completionTime);
          continue;
        }
        
        // Validate the date
        if (isNaN(completionTime.getTime())) {
          console.log(`⚠️  Invalid completion time:`, entry.completionTime);
          continue;
        }
      } else {
        console.log(`⚠️  No completion time found in entry`);
        continue;
      }
      
      const balance = entry.balance.toString(); // Convert BigInt to string
      
      console.log(`  💰 Amount: ${balance} | Completes: ${completionTime.toISOString()}`);
      
      if (!earliestCompletion || completionTime < earliestCompletion) {
        earliestCompletion = completionTime;
        earliestEntry = entry;
        earliestDelegation = delegation;
      }
    }
  }
  
  if (!earliestCompletion) {
    console.log('❌ No valid unbonding entries found');
    return null;
  }
  
  console.log(`\n🎯 Next unbonding completion:`);
  console.log(`   Validator: ${earliestDelegation.validatorAddress}`);
  console.log(`   Amount: ${earliestEntry.balance.toString()}`);
  console.log(`   Completion: ${earliestCompletion.toISOString()}`);
  console.log(`   Time remaining: ${formatTimeRemaining(earliestCompletion)}`);
  
  return {
    completionTime: earliestCompletion,
    amount: earliestEntry.balance.toString(), // Convert BigInt to string
    validator: earliestDelegation.validatorAddress,
    delegation: earliestDelegation,
    entry: earliestEntry
  };
}

function formatTimeRemaining(targetTime) {
  const now = new Date();
  const diff = targetTime.getTime() - now.getTime();
  
  if (diff <= 0) return 'Completed';
  
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diff % (1000 * 60)) / 1000);
  
  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

async function predictUnbondingCompletionBlock(rpcUrl, completionTime) {
  try {
    const currentBlock = await getCurrentBlock(rpcUrl);
    const averageBlockTime = await calculateAverageBlockTime(rpcUrl);
    
    const now = new Date();
    const timeUntilCompletion = (completionTime.getTime() - now.getTime()) / 1000; // seconds
    
    if (timeUntilCompletion <= 0) {
      console.log('⚠️  Unbonding has already completed!');
      return null;
    }
    
    const blocksUntilCompletion = Math.floor(timeUntilCompletion / averageBlockTime);
    const targetBlock = currentBlock.height + blocksUntilCompletion;
    
    console.log(`\n📊 Block Prediction:`);
    console.log(`   Current block: ${currentBlock.height}`);
    console.log(`   Average block time: ${averageBlockTime.toFixed(2)}s`);
    console.log(`   Time until completion: ${timeUntilCompletion.toFixed(0)}s`);
    console.log(`   Estimated completion block: ${targetBlock}`);
    console.log(`   Margin of error: ±${Math.ceil(averageBlockTime)} blocks`);
    
    return {
      targetBlock,
      currentBlock: currentBlock.height,
      averageBlockTime,
      timeUntilCompletion,
      completionTime
    };
  } catch (error) {
    console.error('Error predicting unbonding completion block:', error);
    throw error;
  }
}

async function waitForUnbondingAndExecute(chainConfig, delegatorAddress, earlySubmissionBlocks = 2) {
  console.log(`\n🚀 UNBONDING MODE: Monitoring unbonding completion for ${chainConfig.chainName}`);
  console.log(`👤 Delegator: ${delegatorAddress}`);
  
  try {
    // 1. Find next unbonding completion
    const unbondingInfo = await findNextUnbondingCompletion(chainConfig.rpcUrls[0], delegatorAddress);
    if (!unbondingInfo) {
      console.log('❌ No unbonding delegations found to monitor');
      return false;
    }
    
    // 2. Predict completion block
    const prediction = await predictUnbondingCompletionBlock(chainConfig.rpcUrls[0], unbondingInfo.completionTime);
    if (!prediction) {
      console.log('❌ Could not predict completion block');
      return false;
    }
    
    // 3. Prepare the transaction in advance
    console.log('\n📝 Preparing authz transaction...');
    const { msgs, sendAmounts, granteeAddress } = await prepareAuthzTransaction(chainConfig);
    
    console.log(`💰 Will transfer: ${sendAmounts.map(a => `${a.amount}${a.denom}`).join(', ')}`);
    console.log(`👤 From: ${chainConfig.granter}`);
    console.log(`👤 To: ${granteeAddress}`);
    
    // 4. Wait for completion block (submit early for inclusion)
    const submissionBlock = prediction.targetBlock - earlySubmissionBlocks;
    console.log(`\n⏳ Waiting for submission block ${submissionBlock} (target: ${prediction.targetBlock})`);
    console.log(`🎯 Will submit ${earlySubmissionBlocks} blocks early to ensure inclusion`);
    
    await waitForTargetBlock(chainConfig.rpcUrls, submissionBlock);
    
    // 5. Execute with maximum priority (higher gas for race conditions)
    console.log('\n🏃‍♂️ UNBONDING COMPLETION DETECTED - EXECUTING WITH HIGH PRIORITY!');
    
    // Use higher gas price for unbonding race conditions
    const highPriorityConfig = {
      ...chainConfig,
      gasPrice: (parseFloat(chainConfig.gasPrice) * 3).toString() // 3x gas price
    };
    
    const results = await broadcastToAllRPCs(highPriorityConfig, msgs, granteeAddress);
    
    // 6. Report results
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    
    console.log(`\n✅ Success: ${successful.length}/${results.length} RPCs`);
    if (successful.length > 0) {
      console.log(`🎉 Transaction hash: ${successful[0].result.transactionHash}`);
      console.log(`💰 Unbonding amount secured: ${unbondingInfo.amount}`);
    }
    if (failed.length > 0) {
      console.log(`❌ Failed RPCs: ${failed.length}`);
    }
    
    return successful.length > 0;
    
  } catch (error) {
    console.error(`❌ Error in unbonding monitoring for ${chainConfig.chainName}:`, error);
    return false;
  }
}
async function getCurrentBlock(rpcUrl) {
  const tmClient = await Tendermint37Client.connect(rpcUrl);
  try {
    const status = await tmClient.status();
    await tmClient.disconnect();
    return {
      height: parseInt(status.syncInfo.latestBlockHeight),
      time: new Date(status.syncInfo.latestBlockTime)
    };
  } catch (error) {
    await tmClient.disconnect();
    throw error;
  }
}

async function calculateAverageBlockTime(rpcUrl, sampleSize = 50) {
  const tmClient = await Tendermint37Client.connect(rpcUrl);
  try {
    const latestBlock = await tmClient.block();
    const latestHeight = parseInt(latestBlock.block.header.height);
    const olderHeight = latestHeight - sampleSize;
    
    const olderBlock = await tmClient.block(olderHeight);
    
    const timeDiff = new Date(latestBlock.block.header.time) - new Date(olderBlock.block.header.time);
    const avgBlockTime = timeDiff / (sampleSize * 1000); // Convert to seconds
    
    await tmClient.disconnect();
    return avgBlockTime;
  } catch (error) {
    await tmClient.disconnect();
    throw error;
  }
}

async function predictTargetBlock(rpcUrl, targetTimeMinutes) {
  try {
    const currentBlock = await getCurrentBlock(rpcUrl);
    const averageBlockTime = await calculateAverageBlockTime(rpcUrl);
    
    const targetSeconds = targetTimeMinutes * 60;
    const blocksToAdd = Math.floor(targetSeconds / averageBlockTime);
    const targetBlock = currentBlock.height + blocksToAdd;
    
    console.log(`Current block: ${currentBlock.height}`);
    console.log(`Average block time: ${averageBlockTime.toFixed(2)}s`);
    console.log(`Target block in ${targetTimeMinutes} minutes: ${targetBlock}`);
    console.log(`Estimated execution time: ${new Date(Date.now() + targetTimeMinutes * 60 * 1000).toISOString()}`);
    
    return {
      targetBlock,
      currentBlock: currentBlock.height,
      averageBlockTime,
      estimatedTime: new Date(Date.now() + targetTimeMinutes * 60 * 1000)
    };
  } catch (error) {
    console.error('Error predicting target block:', error);
    throw error;
  }
}

async function waitForTargetBlock(rpcUrls, targetBlock, earlySubmissionBlocks = 2) {
  const pollInterval = 500; // Check every 500ms
  const submissionBlock = targetBlock - earlySubmissionBlocks;
  
  console.log(`Waiting for block ${submissionBlock} to submit (target: ${targetBlock})`);
  
  while (true) {
    for (const rpcUrl of rpcUrls) {
      try {
        const currentBlock = await getCurrentBlock(rpcUrl);
        
        if (currentBlock.height >= submissionBlock) {
          console.log(`Reached submission block ${currentBlock.height} >= ${submissionBlock}`);
          return currentBlock;
        }
        
        // Only log every 10 seconds to avoid spam
        if (currentBlock.height % 10 === 0) {
          const blocksRemaining = submissionBlock - currentBlock.height;
          const timeRemaining = blocksRemaining * 6; // Approximate seconds
          console.log(`Current: ${currentBlock.height}, Target: ${submissionBlock}, Remaining: ~${timeRemaining}s`);
        }
        
        break; // If successful, no need to try other RPCs
      } catch (error) {
        console.log(`RPC ${rpcUrl} failed, trying next...`);
        continue;
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
}

async function broadcastToAllRPCs(chainConfig, msgs, granteeAddress) {
  const results = [];
  
  for (const rpcUrl of chainConfig.rpcUrls) {
    try {
      const { client } = await getSigningClient(
        rpcUrl, 
        chainConfig.prefix, 
        chainConfig.gasPrice, 
        chainConfig.coinType, 
        chainConfig.denom
      );
      
      // Set explicit gas limit and fee for authz transactions
      const gasLimit = "200000"; // Higher gas limit for authz
      const gasPrice = parseFloat(chainConfig.gasPrice);
      const feeAmount = Math.ceil(parseInt(gasLimit) * gasPrice).toString();
      
      const fee = {
        amount: [{ denom: chainConfig.denom, amount: feeAmount }],
        gas: gasLimit,
      };
      
      console.log(`💰 Using gas: ${gasLimit}, fee: ${feeAmount}${chainConfig.denom} on ${rpcUrl}`);
      
      // Sign and broadcast with explicit fee
      const result = await client.signAndBroadcast(granteeAddress, msgs, fee);
      assertIsDeliverTxSuccess(result);
      results.push({ rpcUrl, success: true, result });
      console.log(`✅ Broadcast successful on ${rpcUrl}: ${result.transactionHash}`);
      
    } catch (error) {
      results.push({ rpcUrl, success: false, error: error.message });
      console.log(`❌ Broadcast failed on ${rpcUrl}: ${error.message}`);
    }
  }
  
  return results;
}

async function prepareAuthzTransaction(chainConfig) {
  const { chainName, rpcUrls, prefix, coinType, gasPrice, granter, denom } = chainConfig;
  const primaryRpc = rpcUrls[0];
  
  const { client, address: granteeAddress } = await getSigningClient(primaryRpc, prefix, gasPrice, coinType, denom);
  const recipientAddress = granteeAddress;

  const tmClient = await Tendermint37Client.connect(primaryRpc);
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

  await tmClient.disconnect();
  
  return {
    msgs: [execMsg], // Return the message array for signing later
    sendAmounts,
    granteeAddress
  };
}

async function executeAuthzAfterDelay(chainConfig, delayMinutes = 10) {
  console.log(`\n🚀 Starting timed execution for ${chainConfig.chainName} (${delayMinutes} minutes)`);
  
  try {
    // 1. Predict target block
    const prediction = await predictTargetBlock(chainConfig.rpcUrls[0], delayMinutes);
    
    // 2. Prepare the transaction in advance
    console.log('📝 Preparing authz transaction...');
    const { msgs, sendAmounts, granteeAddress } = await prepareAuthzTransaction(chainConfig);
    
    console.log(`💰 Will transfer: ${sendAmounts.map(a => `${a.amount}${a.denom}`).join(', ')}`);
    console.log(`👤 From: ${chainConfig.granter}`);
    console.log(`👤 To: ${granteeAddress}`);
    
    // 3. Wait for target block
    console.log('⏳ Waiting for target block...');
    await waitForTargetBlock(chainConfig.rpcUrls, prediction.targetBlock);
    
    // 4. Broadcast to all RPCs simultaneously
    console.log('📡 Broadcasting to all RPCs...');
    const results = await broadcastToAllRPCs(chainConfig, msgs, granteeAddress);
    
    // 5. Report results
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    
    console.log(`\n✅ Success: ${successful.length}/${results.length} RPCs`);
    if (successful.length > 0) {
      console.log(`🎉 Transaction hash: ${successful[0].result.transactionHash}`);
    }
    if (failed.length > 0) {
      console.log(`❌ Failed RPCs: ${failed.length}`);
    }
    
    return successful.length > 0;
    
  } catch (error) {
    console.error(`❌ Error executing timed authz for ${chainConfig.chainName}:`, error);
    return false;
  }
}

// Enhanced continuous mode with block-level monitoring
async function executeContinuousWithBlockMonitoring(chainConfig) {
  const { chainName, rpcUrls, prefix, coinType, gasPrice, granter, denom } = chainConfig;
  const primaryRpc = rpcUrls[0];
  
  console.log(`🔄 Starting block-level monitoring for ${chainName}`);
  console.log(`👀 Watching address: ${granter}`);
  
  const { client, address: granteeAddress } = await getSigningClient(primaryRpc, prefix, gasPrice, coinType, denom);
  
  // Pre-check authz grants
  const tmClient = await Tendermint37Client.connect(primaryRpc);
  const queryClient = QueryClient.withExtensions(tmClient, setupAuthzExtension);
  
  try {
    const response = await queryClient.authz.grants(granter, granteeAddress, '/cosmos.bank.v1beta1.MsgSend');
    if (response.grants.length === 0) {
      console.log(`❌ No valid authz grants found for ${chainName}`);
      await tmClient.disconnect();
      return;
    }
    console.log(`✅ Found ${response.grants.length} authz grant(s)`);
  } catch (error) {
    console.log(`❌ Error checking authz grants: ${error.message}`);
    await tmClient.disconnect();
    return;
  }

  let lastBalance = null;
  let lastBlockHeight = 0;
  
  // Pre-prepare transaction components to minimize execution delay
  const prepareTransactionComponents = async () => {
    try {
      const now = Math.floor(Date.now() / 1000);
      let spendLimits = [];
      
      const response = await queryClient.authz.grants(granter, granteeAddress, '/cosmos.bank.v1beta1.MsgSend');
      
      for (const g of response.grants) {
        const expirationSeconds = g.expiration?.seconds ? Number(g.expiration.seconds) : Infinity;
        if (expirationSeconds > now && g.authorization.typeUrl === '/cosmos.bank.v1beta1.SendAuthorization') {
          const { SendAuthorization } = require('cosmjs-types/cosmos/bank/v1beta1/authz');
          const decodedAuth = SendAuthorization.decode(new Uint8Array(Object.values(g.authorization.value)));
          spendLimits = decodedAuth.spendLimit.map(coin => ({ denom: coin.denom, amount: coin.amount }));
          break;
        }
      }
      
      return spendLimits;
    } catch (error) {
      console.log(`⚠️ Error preparing transaction components: ${error.message}`);
      return [];
    }
  };

  console.log(`🏁 Starting real-time block monitoring...`);
  
  while (true) {
    try {
      // Get current block and balance atomically
      const currentBlock = await getCurrentBlock(primaryRpc);
      
      if (currentBlock.height <= lastBlockHeight) {
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }
      
      const spendLimits = await prepareTransactionComponents();
      if (spendLimits.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      
      // Check balance for each monitored denom
      let hasNewFunds = false;
      const sendAmounts = [];
      
      for (const limit of spendLimits) {
        const balance = await client.getBalance(granter, limit.denom);
        const currentAmount = parseInt(balance.amount);
        
        if (lastBalance === null) {
          lastBalance = { [limit.denom]: currentAmount };
          continue;
        }
        
        const previousAmount = lastBalance[limit.denom] || 0;
        
        if (currentAmount > previousAmount && currentAmount > 0) {
          const transferAmount = Math.min(currentAmount, parseInt(limit.amount));
          
          if (transferAmount > 0) {
            hasNewFunds = true;
            sendAmounts.push({
              denom: limit.denom,
              amount: transferAmount.toString()
            });
            
            console.log(`\n🚨 NEW FUNDS DETECTED at block ${currentBlock.height}!`);
            console.log(`💰 ${limit.denom}: ${previousAmount} → ${currentAmount} (+${currentAmount - previousAmount})`);
            console.log(`🔥 EXECUTING IMMEDIATELY with high priority!`);
          }
        }
        
        lastBalance[limit.denom] = currentAmount;
      }
      
      if (hasNewFunds && sendAmounts.length > 0) {
        // IMMEDIATE EXECUTION - Pre-built transaction
        const sendMsgValue = require('cosmjs-types/cosmos/bank/v1beta1/tx').MsgSend.fromPartial({
          fromAddress: granter,
          toAddress: granteeAddress,
          amount: sendAmounts,
        });

        const encodedSendMsg = require('cosmjs-types/google/protobuf/any').Any.fromPartial({
          typeUrl: '/cosmos.bank.v1beta1.MsgSend',
          value: require('cosmjs-types/cosmos/bank/v1beta1/tx').MsgSend.encode(sendMsgValue).finish(),
        });

        const execMsg = {
          typeUrl: '/cosmos.authz.v1beta1.MsgExec',
          value: require('cosmjs-types/cosmos/authz/v1beta1/tx').MsgExec.fromPartial({
            grantee: granteeAddress,
            msgs: [encodedSendMsg],
          }),
        };

        // Ultra-high priority gas for same-block inclusion
        const gasLimit = "150000";
        const gasPriceNum = parseFloat(gasPrice) * 5; // 5x gas price for immediate inclusion
        const feeAmount = Math.ceil(parseInt(gasLimit) * gasPriceNum).toString();
        
        const fee = {
          amount: [{ denom, amount: feeAmount }],
          gas: gasLimit,
        };
        
        console.log(`⚡ Ultra-high priority: ${feeAmount}${denom} gas fee (5x normal)`);
        
        // Parallel broadcast to all RPCs for maximum speed
        const broadcastPromises = rpcUrls.map(async (rpcUrl) => {
          try {
            const { client: rpcClient } = await getSigningClient(rpcUrl, prefix, gasPrice, coinType, denom);
            const startTime = Date.now();
            const result = await rpcClient.signAndBroadcast(granteeAddress, [execMsg], fee);
            const endTime = Date.now();
            
            console.log(`✅ ${rpcUrl}: ${result.transactionHash} (${endTime - startTime}ms)`);
            return { success: true, result, rpcUrl, time: endTime - startTime };
          } catch (error) {
            console.log(`❌ ${rpcUrl}: ${error.message}`);
            return { success: false, error: error.message, rpcUrl };
          }
        });
        
        const results = await Promise.allSettled(broadcastPromises);
        const successful = results.filter(r => r.status === 'fulfilled' && r.value.success);
        
        if (successful.length > 0) {
          const fastest = successful.reduce((min, current) => 
            current.value.time < min.value.time ? current : min
          );
          
          console.log(`🎉 SUCCESS! Fastest execution: ${fastest.value.time}ms`);
          console.log(`🔗 TX: ${fastest.value.result.transactionHash}`);
          console.log(`💸 Transferred: ${sendAmounts.map(a => `${a.amount}${a.denom}`).join(', ')}`);
          
          // Check if we made it to the same block
          const finalBlock = await getCurrentBlock(primaryRpc);
          if (finalBlock.height === currentBlock.height) {
            console.log(`🏆 SAME-BLOCK EXECUTION! Block ${currentBlock.height}`);
          } else {
            console.log(`⏱️ Executed in block ${finalBlock.height} (detection: ${currentBlock.height})`);
          }
        } else {
          console.log(`❌ All broadcasts failed`);
        }
        
        // Brief pause before resuming monitoring
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      lastBlockHeight = currentBlock.height;
      
      // Minimal delay for high-frequency monitoring
      await new Promise(resolve => setTimeout(resolve, 200)); // Check every 200ms
      
    } catch (error) {
      console.log(`⚠️ Monitoring error: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  await tmClient.disconnect();
}
async function executeSendWithAuthz(chainConfig) {
  const { chainName, rpcUrls, prefix, coinType, gasPrice, granter, denom } = chainConfig;
  const primaryRpc = rpcUrls[0];
  
  console.log(`🔍 Checking ${chainName} for available funds...`);
  
  const { client, address: granteeAddress } = await getSigningClient(primaryRpc, prefix, gasPrice, coinType, denom);
  const recipientAddress = granteeAddress;

  const tmClient = await Tendermint37Client.connect(primaryRpc);
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

  if (spendLimits.length === 0) {
    console.log(`⚠️  No valid authz grants found for ${chainName}`);
    await tmClient.disconnect();
    return null;
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

  if (sendAmounts.length === 0) {
    console.log(`💸 No funds available to transfer on ${chainName}`);
    await tmClient.disconnect();
    return null;
  }

  console.log(`💰 Found transferable funds on ${chainName}: ${sendAmounts.map(a => `${a.amount}${a.denom}`).join(', ')}`);
  console.log(`👤 From: ${granter} → To: ${granteeAddress}`);

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

  // Set explicit gas limit and fee for authz transactions (same as timed mode)
  const gasLimit = "150000";
  const gasPriceNum = parseFloat(gasPrice);
  const feeAmount = Math.ceil(parseInt(gasLimit) * gasPriceNum).toString();
  
  const fee = {
    amount: [{ denom, amount: feeAmount }],
    gas: gasLimit,
  };
  
  console.log(`📡 Submitting transaction with gas: ${gasLimit}, fee: ${feeAmount}${denom}`);
  
  const result = await client.signAndBroadcast(granteeAddress, [execMsg], fee);
  assertIsDeliverTxSuccess(result);
  await tmClient.disconnect();
  
  console.log(`✅ Transaction successful on ${chainName}: ${result.transactionHash}`);
  console.log(`🔗 Explorer: https://ping.pub/chihuahua/tx/${result.transactionHash}`);
  
  return result;
}

// Main execution modes
async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || 'timed'; // 'timed', 'continuous', or 'unbonding'
  const delayMinutes = parseInt(args[1]) || 10;

  if (mode === 'timed') {
    console.log(`🎯 TIMED MODE: Executing after ${delayMinutes} minutes`);
    
    for (const chainConfig of CHAIN_CONFIGS) {
      await executeAuthzAfterDelay(chainConfig, delayMinutes);
    }
    
  } else if (mode === 'unbonding') {
    console.log('🔓 UNBONDING MODE: Monitoring unbonding completions');
    
    // Get delegator address (try args, env, or use granter as default)
    let delegatorAddress = args[1] || process.env.DELEGATOR_ADDRESS;
    
    if (!delegatorAddress && CHAIN_CONFIGS.length > 0) {
      delegatorAddress = CHAIN_CONFIGS[0].granter;
      console.log(`📝 Using granter address as delegator: ${delegatorAddress}`);
    }
    
    if (!delegatorAddress) {
      console.error('❌ Delegator address required for unbonding mode');
      console.log('Usage: node chihuahua.js unbonding <delegator_address>');
      console.log('   or: set DELEGATOR_ADDRESS in .env file');
      console.log('   or: script will use granter address by default');
      return;
    }
    
    for (const chainConfig of CHAIN_CONFIGS) {
      await waitForUnbondingAndExecute(chainConfig, delegatorAddress);
    }
    
  } else if (mode === 'continuous') {
    console.log('🔄 CONTINUOUS MODE: Real-time block monitoring for same-block execution');
    console.log(`⚡ High-frequency monitoring every 200ms`);
    console.log(`📋 Monitoring ${CHAIN_CONFIGS.length} chain(s): ${CHAIN_CONFIGS.map(c => c.chainName).join(', ')}`);
    console.log('🛑 Press Ctrl+C to stop\n');
    
    // Use enhanced block monitoring for all chains
    const monitoringPromises = CHAIN_CONFIGS.map(chainConfig => 
      executeContinuousWithBlockMonitoring(chainConfig)
    );
    
    await Promise.all(monitoringPromises);
    
  } else if (mode === 'continuous-legacy') {
  } else if (mode === 'continuous-legacy') {
    console.log('🔄 CONTINUOUS LEGACY MODE: Standard 2-second polling');
    console.log(`⏰ Checking every 2 seconds for available funds...`);
    console.log(`📋 Monitoring ${CHAIN_CONFIGS.length} chain(s): ${CHAIN_CONFIGS.map(c => c.chainName).join(', ')}`);
    console.log('🛑 Press Ctrl+C to stop\n');
    
    while (true) {
      const timestamp = new Date().toISOString();
      console.log(`\n[${timestamp}] 🔍 Starting check cycle...`);
      
      for (const chainConfig of CHAIN_CONFIGS) {
        try {
          const result = await executeSendWithAuthz(chainConfig);
          if (result) {
            console.log(`🎉 Successfully executed transfer on ${chainConfig.chainName}!`);
          }
        } catch (error) {
          console.log(`❌ Error on ${chainConfig.chainName}: ${error.message}`);
        }
      }
      
      console.log(`⏳ Waiting 2 seconds before next check...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } else {
    console.log('Usage:');
    console.log('  node atom.js timed [minutes]              - Execute after specified minutes (default: 10)');
    console.log('  node atom.js unbonding <delegator_addr>   - Monitor unbonding completion and execute');
    console.log('  node atom.js continuous                   - Real-time block monitoring (same-block execution)');
    console.log('  node atom.js continuous-legacy            - Standard 2-second polling');
    console.log('');
    console.log('Examples:');
    console.log('  node atom.js unbonding chihuahua1abc123...');
    console.log('  node atom.js timed 5');
    console.log('  node atom.js continuous');
    console.log('');
    console.log('Environment Variables:');
    console.log('  DELEGATOR_ADDRESS - Set delegator address for unbonding mode');
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down gracefully...');
  process.exit(0);
});

main().catch(console.error);