const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const axios = require('axios');
require('dotenv').config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const server = new StellarSdk.Server('https://api.mainnet.minepi.com');
const mnemonic = process.env.MNEMONIC;
const recipient = process.env.RECEIVER_ADDRESS;

async function getPiWalletAddressFromSeed(mnemonic) {
  if (!bip39.validateMnemonic(mnemonic)) throw new Error("Mnemonic tidak valid");
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const { key } = ed25519.derivePath("m/44'/314159'/0'", seed.toString('hex'));
  const keypair = StellarSdk.Keypair.fromRawEd25519Seed(key);
  return { publicKey: keypair.publicKey(), secretKey: keypair.secret() };
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

async function checkConditionsAndExecute() {
  try {
    const wallet = await getPiWalletAddressFromSeed(mnemonic);
    const senderKeypair = StellarSdk.Keypair.fromSecret(wallet.secretKey);
    const senderPublic = wallet.publicKey;

    const resAccount = await axios.get(`https://api.mainnet.minepi.com/accounts/${senderPublic}`);
    const nativeBalanceObj = resAccount.data.balances.find(b => b.asset_type === 'native');
    const balance = nativeBalanceObj ? parseFloat(nativeBalanceObj.balance) : 0;

    const resClaim = await axios.get(`https://api.mainnet.minepi.com/claimable_balances?claimant=${senderPublic}&limit=100`);
    const claimables = resClaim.data._embedded?.records || [];

    const canWithdraw = balance > 2;
    const canClaim = claimables.length > 0;

    if (!canWithdraw && !canClaim) {
      console.log("⏳ Menunggu saldo bisa di-claim atau dikirim...");
      return;
    }

    if (canClaim) {
      console.log(`📥 Ada ${claimables.length} claimable balances. Klaim...`);
      for (const claim of claimables) {
        try {
          const account = await server.loadAccount(senderPublic);
          const baseFee = await server.fetchBaseFee();

          const tx = new StellarSdk.TransactionBuilder(account, {
            fee: baseFee.toString(),
            networkPassphrase: 'Pi Network',
          })
            .addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId: claim.id }))
            .setTimeout(30)
            .build();

          tx.sign(senderKeypair);
          const result = await server.submitTransaction(tx);
          console.log(`✅ Klaim berhasil ID ${claim.id}`);
        } catch (err) {
          console.error(`❌ Gagal klaim ${claim.id}:`, err.response?.data || err.message || err);
        }
      }
    }

    if (canWithdraw) {
      const withdrawAmount = balance - 2;
      const amountStr = withdrawAmount.toFixed(7);
      const baseFee = await server.fetchBaseFee();
      const account = await server.loadAccount(senderPublic);

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
      console.log(`✅ Kirim ${amountStr} Pi berhasil!`);
      console.log(`🔗 ${explorerLink}`);

      await notifyTelegram(`✅ Berhasil kirim ${amountStr} Pi ke ${recipient}\n🔗 ${explorerLink}`);
    }

  } catch (e) {
    console.error("❌ Error saat proses:", e.response?.data || e.message || e);
  }
}

// Loop tiap 100ms, tapi hanya proses saat perlu
setInterval(checkConditionsAndExecute, 100);
