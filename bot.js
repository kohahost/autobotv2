// index.js
const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const axios = require('axios');
require('dotenv').config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MIN_SEND_BALANCE = 2.0001;

let isProcessing = false;
let lastAccountData = null;
let lastClaimables = null;

async function getPiWalletAddressFromSeed(mnemonic) {
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error("Mnemonic tidak valid");
  }
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const { key } = ed25519.derivePath("m/44'/314159'/0'", seed.toString('hex'));
  const keypair = StellarSdk.Keypair.fromRawEd25519Seed(key);
  return {
    publicKey: keypair.publicKey(),
    secretKey: keypair.secret(),
  };
}

async function notifyTelegram(message) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "Markdown"
    });
  } catch (e) {
    console.error("❌ Gagal kirim notifikasi Telegram:", e.message);
  }
}

async function checkIfShouldRequest() {
  if (isProcessing) return false;

  const nativeBalance = lastAccountData?.balances?.find(b => b.asset_type === 'native');
  const balance = nativeBalance ? parseFloat(nativeBalance.balance) : 0;
  if (balance > MIN_SEND_BALANCE) return true;

  if (lastClaimables && lastClaimables.length > 0) return true;

  return false;
}

async function processClaimAndSend() {
  const server = new StellarSdk.Server('https://api.mainnet.minepi.com');
  const mnemonic = process.env.MNEMONIC;
  const recipient = process.env.RECEIVER_ADDRESS;

  const wallet = await getPiWalletAddressFromSeed(mnemonic);
  const senderKeypair = StellarSdk.Keypair.fromSecret(wallet.secretKey);
  const senderPublic = wallet.publicKey;

  const accountRes = await axios.get(`https://api.mainnet.minepi.com/accounts/${senderPublic}`);
  lastAccountData = accountRes.data;

  const nativeBalanceObj = lastAccountData.balances.find(b => b.asset_type === 'native');
  const balance = nativeBalanceObj ? parseFloat(nativeBalanceObj.balance) : 0;

  const claimUrl = `https://api.mainnet.minepi.com/claimable_balances?claimant=${senderPublic}&limit=100`;
  const claimRes = await axios.get(claimUrl);
  lastClaimables = claimRes.data._embedded?.records || [];

  if (lastClaimables.length > 0) {
    console.log(`📥 Klaim ${lastClaimables.length} saldo...`);
    for (const claim of lastClaimables) {
      try {
        const account = await server.loadAccount(senderPublic);
        const baseFee = await server.fetchBaseFee();

        const tx = new StellarSdk.TransactionBuilder(account, {
          fee: baseFee.toString(),
          networkPassphrase: 'Pi Network',
        })
          .addOperation(StellarSdk.Operation.claimClaimableBalance({
            balanceId: claim.id
          }))
          .setTimeout(30)
          .build();

        tx.sign(senderKeypair);
        await server.submitTransaction(tx);
        console.log(`✅ Klaim berhasil: ${claim.id}`);
      } catch (err) {
        console.error(`⚠️ Klaim gagal (${claim.id}):`, err.message);
      }
    }
  }

  const updatedRes = await axios.get(`https://api.mainnet.minepi.com/accounts/${senderPublic}`);
  lastAccountData = updatedRes.data;

  const newBalanceObj = lastAccountData.balances.find(b => b.asset_type === 'native');
  const newBalance = newBalanceObj ? parseFloat(newBalanceObj.balance) : 0;

  const withdrawAmount = newBalance - 2;
  if (withdrawAmount <= 0) {
    console.log("⚠️ Saldo belum cukup untuk kirim.");
    return;
  }

  const amountStr = withdrawAmount.toFixed(7);
  console.log(`➡️ Mengirim ${amountStr} Pi ke ${recipient}`);

  const account = await server.loadAccount(senderPublic);
  const baseFee = await server.fetchBaseFee();

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: baseFee.toString(),
    networkPassphrase: 'Pi Network',
  })
    .addOperation(StellarSdk.Operation.payment({
      destination: recipient,
      asset: StellarSdk.Asset.native(),
      amount: amountStr,
    }))
    .setTimeout(30)
    .build();

  tx.sign(senderKeypair);
  const result = await server.submitTransaction(tx);
  const txHash = result.hash;
  const explorerLink = `https://api.mainnet.minepi.com/transactions/${txHash}`;

  console.log(`✅ Kirim sukses! 🔗 ${explorerLink}`);
  await notifyTelegram(`✅ Kirim ${amountStr} Pi sukses!\n🔗 ${explorerLink}`);
}

setInterval(async () => {
  const shouldProcess = await checkIfShouldRequest();
  if (!shouldProcess) return;

  isProcessing = true;
  try {
    await processClaimAndSend();
  } catch (e) {
    console.error("❌ Error saat proses:", e.message);
  } finally {
    isProcessing = false;
  }
}, 100);
