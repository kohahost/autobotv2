const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const axios = require('axios');
require('dotenv').config();

// Telegram Bot info
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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

async function claimAllBalances(server, senderKeypair, senderPublic) {
  try {
    const claimUrl = `https://api.mainnet.minepi.com/claimable_balances?claimant=${senderPublic}&limit=100`;
    const resClaim = await axios.get(claimUrl);
    const claimables = resClaim.data._embedded?.records || [];

    if (claimables.length === 0) {
      console.log("📥 Tidak ada claimable balances.");
      return;
    }

    console.log(`📥 Ada ${claimables.length} claimable balances. Klaim satu per satu...`);

    for (const claim of claimables) {
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

        const result = await server.submitTransaction(tx);
        console.log(`✅ Berhasil klaim ID ${claim.id}`);
      } catch (err) {
        const errorMsg = err.response?.data || err.message || err;
        console.error(`⚠️ Gagal klaim ID ${claim.id}:`, errorMsg);

        // Notifikasi jika error karena underfunded
        if (JSON.stringify(errorMsg).includes("paymentUnderfunded")) {
          await notifyTelegram(`❌ Gagal klaim ID ${claim.id}: paymentUnderfunded`);
        }
      }
    }
  } catch (err) {
    console.error("❌ Error saat cek/klaim:", err.response?.data || err.message || err);
  }
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

async function sendPi() {
  const server = new StellarSdk.Server('https://api.mainnet.minepi.com');
  const mnemonic = process.env.MNEMONIC;
  const recipient = process.env.RECEIVER_ADDRESS;

  try {
    const wallet = await getPiWalletAddressFromSeed(mnemonic);
    const senderKeypair = StellarSdk.Keypair.fromSecret(wallet.secretKey);
    const senderPublic = wallet.publicKey;

    console.log(`🚀 Alamat Dompet Pi: ${senderPublic}`);

    // 1. Klaim semua claimable balance
    await claimAllBalances(server, senderKeypair, senderPublic);

    // 2. Ambil saldo terbaru
    const resAccount = await axios.get(`https://api.mainnet.minepi.com/accounts/${senderPublic}`);
    const nativeBalanceObj = resAccount.data.balances.find(b => b.asset_type === 'native');
    const balance = nativeBalanceObj ? parseFloat(nativeBalanceObj.balance) : 0;
    console.log(`💰 Saldo: ${balance} Pi`);

    const baseFee = await server.fetchBaseFee();
    const fee = (baseFee * 2).toString(); // Buffer biaya 2x
    const withdrawAmount = balance - 2; // Sisakan 2 Pi

    if (withdrawAmount <= 0) {
      console.log("⚠️ Saldo tidak cukup");
      await notifyTelegram(`⚠️ Saldo tidak cukup untuk kirim dari ${senderPublic}`);
      return;
    }

    const amountStr = withdrawAmount.toFixed(7);
    console.log(`➡️ Mengirim ${amountStr} Pi ke ${recipient}`);

    const account = await server.loadAccount(senderPublic);
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee,
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

    console.log(`✅ Transaksi berhasil! TxHash: ${txHash}`);
    console.log(`🔗 ${explorerLink}`);

    await notifyTelegram(`✅ Berhasil kirim ${amountStr} Pi ke ${recipient}\n🔗 ${explorerLink}`);

  } catch (e) {
    console.error("❌ Error saat mengirim:", e.response?.data || e.message || e);
    await notifyTelegram(`❌ Gagal mengirim: ${e.response?.data?.extras?.result_codes?.operations || e.message}`);
  } finally {
    console.log("⏳ Tunggu 2 detik...\n");
    setTimeout(sendPi, 2000);
  }
}

sendPi();
