const express = require('express');
const cors = require('cors');
const bitcoin = require('bitcoinjs-lib');
const bip32 = require('bip32');
const axios = require('axios');
const Client = require('bitcoin-core');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const rpc = new Client({
  host: process.env.BITCOIN_RPC_HOST || 'bitcoin',
  port: Number(process.env.BITCOIN_RPC_PORT) || 8332,
  username: process.env.BITCOIN_RPC_USER,
  password: process.env.BITCOIN_RPC_PASS,
});

app.post('/api/load', async (req, res) => {
  const { xpub, label = "My Holdings" } = req.body;

  if (!xpub || !xpub.startsWith('xpub')) {
    return res.status(400).json({ error: "Valid xpub is required" });
  }

  try {
    const network = bitcoin.networks.bitcoin;
    const node = bip32.fromBase58(xpub, network);
    
    const addresses = [];
    for (let i = 0; i < 300; i++) {   // First 300 receive addresses
      const child = node.derive(0).derive(i);
      const { address } = bitcoin.payments.p2wpkh({ pubkey: child.publicKey, network });
      addresses.push(address);
    }

    const utxos = await rpc.command('listunspent', 0, 9999999, addresses);

    const priceRes = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
    const currentPrice = priceRes.data.bitcoin.usd;

    let totalBtc = 0;
    let totalCost = 0;
    const enriched = [];

    for (const utxo of utxos) {
      const tx = await rpc.command('getrawtransaction', utxo.txid, true);
      const receiveTime = new Date(tx.time * 1000);
      const dateStr = receiveTime.toISOString().split('T')[0];

      let historicalPrice = currentPrice;
      try {
        const hist = await axios.get(`https://api.coingecko.com/api/v3/coins/bitcoin/history?date=${dateStr.replace(/-/g, '')}`);
        historicalPrice = hist.data.market_data?.current_price?.usd || currentPrice;
      } catch (e) {}

      const valueNow = utxo.amount * currentPrice;
      const costBasis = utxo.amount * historicalPrice;
      const pnl = valueNow - costBasis;

      enriched.push({
        date: dateStr,
        amount: utxo.amount,
        priceThen: Math.round(historicalPrice),
        valueNow: Math.round(valueNow),
        pnl: Math.round(pnl),
        pnlPct: costBasis > 0 ? Math.round((pnl / costBasis) * 100) : 0
      });

      totalBtc += utxo.amount;
      totalCost += costBasis;
    }

    const totalValue = Math.round(totalBtc * currentPrice);
    const totalPnl = Math.round(totalValue - totalCost);

    res.json({
      label,
      totalBtc: totalBtc.toFixed(4),
      totalValue,
      totalCost: Math.round(totalCost),
      totalPnl,
      totalPnlPct: totalCost > 0 ? Math.round((totalPnl / totalCost) * 100) : 0,
      currentPrice,
      utxos: enriched.sort((a, b) => new Date(b.date) - new Date(a.date))
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to scan wallet. Try again." });
  }
});

app.listen(3000, '0.0.0.0', () => {
  console.log('Holdings Dashboard running');
});
