const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const axios = require('axios');
require('dotenv').config();

const server = new StellarSdk.Server('https://api.mainnet.minepi.com');
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function getWalletFromMnemonic(mnemonic) {
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

async function checkAndClaimBalances(senderKeypair, senderPublic) {
  try {
    const claimables = await axios.get(`https://api.mainnet.minepi.com/claimable_balances?claimant=${senderPublic}&limit=100`);
    const records = claimables.data._embedded?.records || [];

    for (const claim of records) {
      const account = await server.loadAccount(senderPublic);
      const fee = await server.fetchBaseFee();

      const tx = new StellarSdk.TransactionBuilder(account, {
        fee: fee.toString(),
        networkPassphrase: 'Pi Network',
      })
        .addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId: claim.id }))
        .setTimeout(30)
        .build();

      tx.sign(senderKeypair);
      await server.submitTransaction(tx);
      console.log(`✅ Klaim balance ID: ${claim.id}`);
    }

    return records.length > 0;
  } catch (e) {
    console.error("❌ Gagal klaim:", e.response?.data || e.message || e);
    return false;
  }
}

async function checkAndSendPi(senderKeypair, senderPublic, recipient) {
  try {
    const res = await axios.get(`https://api.mainnet.minepi.com/accounts/${senderPublic}`);
    const native = res.data.balances.find(b => b.asset_type === 'native');
    const balance = native ? parseFloat(native.balance) : 0;

    if (balance <= 2) return;

    const withdrawAmount = (balance - 2).toFixed(7);
    const account = await server.loadAccount(senderPublic);
    const fee = await server.fetchBaseFee();

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: fee.toString(),
      networkPassphrase: 'Pi Network',
    })
      .addOperation(StellarSdk.Operation.payment({
        destination: recipient,
        asset: StellarSdk.Asset.native(),
        amount: withdrawAmount,
      }))
      .setTimeout(30)
      .build();

    tx.sign(senderKeypair);
    const result = await server.submitTransaction(tx);

    console.log(`✅ Transfer ${withdrawAmount} Pi ke ${recipient}`);
    await notifyTelegram(`✅ Transfer ${withdrawAmount} Pi ke ${recipient}\n🔗 https://api.mainnet.minepi.com/transactions/${result.hash}`);
  } catch (e) {
    console.error("❌ Error saat kirim:", e.response?.data || e.message || e);
  }
}

(async () => {
  const wallet = await getWalletFromMnemonic(process.env.MNEMONIC);
  const senderKeypair = StellarSdk.Keypair.fromSecret(wallet.secretKey);
  const senderPublic = wallet.publicKey;
  const recipient = process.env.RECEIVER_ADDRESS;

  console.log(`🌀 Monitoring saldo dan klaim di alamat: ${senderPublic}`);

  // Jalankan stream listener
  server.accounts()
    .accountId(senderPublic)
    .stream({
      onmessage: async () => {
        console.log(`📡 Deteksi perubahan akun...`);

        const claimed = await checkAndClaimBalances(senderKeypair, senderPublic);
        if (claimed) console.log("📥 Ada saldo yang berhasil diklaim.");

        await checkAndSendPi(senderKeypair, senderPublic, recipient);
      },
      onerror: (err) => {
        console.error("🔌 Stream error:", err.message);
        setTimeout(() => process.exit(1), 5000); // biar bisa restart pakai pm2
      }
    });
})();
