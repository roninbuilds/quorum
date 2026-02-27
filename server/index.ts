/**
 * server/index.ts
 * Express API server for Quorum
 * The boring glue between the fun parts
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import * as dotenv from 'dotenv';
import routes from './routes';
import { scrapeEvents } from '../bot/scraper';
import { startSMSLoop } from '../bot/sms-loop';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3000');
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../web')));

// API routes
app.use('/api', routes);

// Serve web UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../web/index.html'));
});

app.get('/venue-intel', (req, res) => {
  res.sendFile(path.join(__dirname, '../web/venue-intel.html'));
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`\n🎫 QUORUM server running on http://localhost:${PORT}`);
  console.log(`📊 Venue intelligence: http://localhost:${PORT}/venue-intel`);
  console.log(`⚡ Solana: ${process.env.SOLANA_RPC_URL}`);
  console.log(`🌐 Node env: ${process.env.NODE_ENV}\n`);

  // Kick off initial event scrape in background
  console.log('🔍 Scraping LPR events...');
  scrapeEvents().then(events => {
    console.log(`✅ Scraped ${events.length} events from LPR`);
  }).catch(err => {
    console.warn('⚠️ Initial scrape failed (non-fatal):', err.message);
  });

  // Start LLM-powered SMS loop
  startSMSLoop().catch(err => {
    console.error('SMS loop crashed:', err.message);
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  server.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n👋 Quorum shutting down. Your fans will have to wait.');
  server.close();
  process.exit(0);
});
