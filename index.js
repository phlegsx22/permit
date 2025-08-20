require('dotenv').config();
const { MongoClient } = require('mongodb');
const { submitPermits } = require('./permitSubmit');
const { transferTokens } = require('./transfer');
const { withdrawTokens } = require('./withdraw');

const MONGO_URI = process.env.MONGO_URI;
const client = new MongoClient(MONGO_URI);

async function runWorkflow() {
  try {
    await client.connect();
    console.log('Connected to MongoDB');

    console.log('Starting permit submission...');
    await submitPermits(client);
    console.log('Permit submission completed.');

    console.log('Starting token transfer...');
    await transferTokens(client);
    console.log('Token transfer completed.');

    console.log('Starting token withdrawal...');
    await withdrawTokens(client);
    console.log('Token withdrawal completed.');
  } catch (error) {
    console.error('Workflow failed:', error);
  } finally {
    await client.close();
    console.log('Database connection closed.');
    process.exit(0);
  }
}

runWorkflow().catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});



