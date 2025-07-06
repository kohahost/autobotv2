const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const axios = require('axios');
require('dotenv').config();

// Telegram Bot info
const TELEGRAM_TOKEN = "7533580803:AAHzOk1fjnfwnwYwB-Gz63S-mYo1F5WoFk0";
const TELEGRAM_CHAT_ID = "7890743177";

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

// Fungsi klaim semua claimable balances
async function claimAllBalances(server, senderKeypair, senderPublic) {
  try {
    const claimUrl = `https://api.mainnet.minepi.com/claimable_balances?claimant=${senderPublic}&limit=10`;
    const resClaim = await axios.get(claimUrl);
    const claimables = resClaim.data._embedded?.records || [];
    
    if (claimables.length === 0) {
      console.log("📥 Tidak ada claimable balances.");
      return;
    }
    
    console.log(`📥 Ada ${claimables.length} claimable balances. Klaim satu per satu...`);

    for (const claim of claimables) {
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

      try {
        const result = await server.submitTransaction(tx);
        console.log(`✅ Berhasil klaim claimable balance ID ${claim.id}`);
      } catch (err) {
        console.error(`⚠️ Gagal klaim claimable balance ID ${claim.id}:`, err.response?.data || err.message || err);
      }
    }
  } catch (err) {
    console.error("❌ Error saat cek/klaim claimable balances:", err.response?.data || err.message || err);
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

    console.log(`\n🚀 Alamat Dompet Pi: ${senderPublic}`);

    // 1. Klaim dulu semua claimable balances
    await claimAllBalances(server, senderKeypair, senderPublic);

    // 2. Setelah klaim, ambil saldo native yang terbaru
    const accountUrl = `https://api.mainnet.minepi.com/accounts/${senderPublic}`;
    const resAccount = await axios.get(accountUrl);
    const nativeBalanceObj = resAccount.data.balances.find(b => b.asset_type === 'native');
    const balance = nativeBalanceObj ? nativeBalanceObj.balance : '0';
    console.log(`💰 Saldo native setelah klaim: ${balance}`);

    // 3. Load account stellar terbaru
    const account = await server.loadAccount(senderPublic);
    const baseFee = await server.fetchBaseFee();
    const fee = (baseFee * 2).toString();
    console.log(`💸 Biaya Dasar: ${baseFee / 1e7}, Biaya Dua Kali: ${fee / 1e7}`);

    // 4. Hitung jumlah yang bisa dikirim (sisakan 2 Pi untuk fee)
    const withdrawAmount = Number(balance) - 2;
    if (withdrawAmount <= 0) {
      console.log("⚠️ Saldo tidak cukup");
    } else {
      const amountStr = withdrawAmount.toFixed(7);
      console.log(`➡️ Mengirim ${amountStr} Pi ke ${recipient}`);

      // 5. Build transaksi payment
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

      if (result && result.hash) {
        const txHash = result.hash;
        const explorerLink = `https://api.mainnet.minepi.com/transactions/${txHash}`;

        console.log(`✅ Transaksi berhasil! TxHash: ${txHash}`);
        console.log(`🔗 Lihat di: ${explorerLink}`);

        // Kirim notifikasi Telegram
        const message = `
✅ Berhasil kirim ${amountStr} Pi
📬 Ke: ${recipient}
🔗 Tx: ${explorerLink}
        `.trim();

        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "Markdown"
        });
      } else {
        console.log("⚠️ Transaksi gagal:", result);
      }
    }
  } catch (e) {
    console.error("❌ Error:", e.response?.data || e.message || e);
  } finally {
    console.log("⏳ Tunggu 1 detik\n");
    setTimeout(sendPi, 1000); // Delay 1 detik untuk mencegah spam server
  }
}

sendPi();
