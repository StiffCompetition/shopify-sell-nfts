import React, { useState, useEffect } from 'react';
import { createThirdwebClient } from 'thirdweb';
import { inAppWallet, preAuthenticate } from 'thirdweb/wallets/in-app';
import { polygon } from 'thirdweb/chains';

const client = createThirdwebClient({
  clientId: '5b6fea50005cae4d61448c7a4306866f',
});

const styles = {
  container: { fontFamily: 'Arial, sans-serif', maxWidth: 500, margin: '50px auto', padding: 20, textAlign: 'center' },
  input: { width: '100%', padding: 12, margin: '10px 0', border: '1px solid #ccc', borderRadius: 4, boxSizing: 'border-box', fontSize: 14 },
  button: { width: '100%', padding: 12, background: '#000', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 16, margin: '5px 0' },
  buttonDisabled: { width: '100%', padding: 12, background: '#999', color: '#fff', border: 'none', borderRadius: 4, cursor: 'not-allowed', fontSize: 16, margin: '5px 0' },
  buttonBack: { width: '100%', padding: 12, background: '#555', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 16, margin: '5px 0' },
  or: { margin: '15px 0', color: '#999' },
  success: { marginTop: 20, padding: 15, borderRadius: 4, background: '#d4edda', color: '#155724', lineHeight: 1.6 },
  error: { marginTop: 20, padding: 15, borderRadius: 4, background: '#f8d7da', color: '#721c24' },
  info: { marginTop: 20, padding: 15, borderRadius: 4, background: '#d1ecf1', color: '#0c5460' },
  otpInput: { width: '100%', padding: 12, margin: '10px 0', border: '1px solid #ccc', borderRadius: 4, boxSizing: 'border-box', fontSize: 20, letterSpacing: 6, textAlign: 'center' },
  link: { color: '#155724', fontWeight: 'bold' },
  nftLink: { display: 'block', margin: '6px 0', color: '#155724', fontWeight: 'bold' },
  ul: { textAlign: 'left', margin: '15px 0', paddingLeft: 20 },
  hint: { fontSize: 13, color: '#555', margin: '8px 0' },
  bookmark: { marginTop: 16, fontSize: 13, color: '#555', lineHeight: 1.6 },
  hidden: { display: 'none' },
};

export default function ClaimPage({ orderId }) {
  const [step, setStep] = useState('loading'); // loading, choose, otp, success, error
  const [items, setItems] = useState([]);
  const [walletAddress, setWalletAddress] = useState('');
  const [email, setEmail] = useState('');
  const [walletEmail, setWalletEmail] = useState('');
  const [emailHint, setEmailHint] = useState('');
  const [pendingEmail, setPendingEmail] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [message, setMessage] = useState(null); // { text, type }
  const [busy, setBusy] = useState(false);
  const [mintedItems, setMintedItems] = useState([]);
  const [usedEmail, setUsedEmail] = useState(null);
  const [walletAddr, setWalletAddr] = useState(null);

  useEffect(() => {
    loadOrder();
  }, [orderId]);

  async function loadOrder() {
    try {
      const res = await fetch(`/claim/order/${orderId}/details`);
      const data = await res.json();
      if (data.error) {
        setStep('error');
        setMessage({ text: data.error, type: 'error' });
      } else {
        setItems(data.items);
        setEmailHint(data.emailHint || '');
        setStep('choose');
      }
    } catch (e) {
      setStep('error');
      setMessage({ text: 'Failed to load order. Please try again.', type: 'error' });
    }
  }

  async function claimWithWallet() {
    if (!walletEmail.trim()) {
      setMessage({ text: 'Please enter the email address on your order', type: 'error' });
      return;
    }
    if (!walletAddress.trim()) {
      setMessage({ text: 'Please enter your wallet address', type: 'error' });
      return;
    }
    setMessage({ text: 'Minting your NFT — this may take up to 2 minutes, please do not close this page...', type: 'info' });
    await submitClaim(walletAddress.trim(), walletEmail.trim(), null);
  }

  async function sendOTP() {
    if (!email.trim()) {
      setMessage({ text: 'Please enter your email address', type: 'error' });
      return;
    }
    setBusy(true);
    setMessage({ text: 'Sending your verification code...', type: 'info' });
    try {
      await preAuthenticate({
        client,
        strategy: 'email',
        email: email.trim(),
      });
      setPendingEmail(email.trim());
      setStep('otp');
      setMessage(null);
    } catch (e) {
      setMessage({ text: 'Could not send verification code. Please try again.', type: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function verifyOTP() {
    if (!otpCode || otpCode.length < 6) {
      setMessage({ text: 'Please enter the 6-digit code from your email', type: 'error' });
      return;
    }
    setBusy(true);
    setMessage({ text: 'Verifying your code...', type: 'info' });
    try {
      const wallet = inAppWallet();
      const account = await wallet.connect({
        client,
        chain: polygon,
        strategy: 'email',
        email: pendingEmail,
        verificationCode: otpCode,
      });
      const address = account.address;
      setMessage({ text: 'Code verified! Minting your NFT — this may take up to 2 minutes, please do not close this page...', type: 'info' });
      await submitClaim(address, pendingEmail, pendingEmail);
    } catch (e) {
      setMessage({ text: 'Invalid code — please check your email and try again', type: 'error' });
      setBusy(false);
    }
  }

  // verifyEmail is checked server-side against the address the order was placed with.
  async function submitClaim(address, verifyEmail, walletCreatedFor) {
    setBusy(true);
    try {
      const res = await fetch(`/claim/order/${orderId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: address, email: verifyEmail, walletCreated: !!walletCreatedFor }),
      });
      const data = await res.json();
      if (data.success) {
        setMintedItems(data.items || []);
        setUsedEmail(walletCreatedFor);
        setWalletAddr(data.walletAddress || address);
        setStep('success');
      } else {
        setMessage({ text: data.error, type: 'error' });
        setBusy(false);
      }
    } catch (e) {
      setMessage({ text: 'Something went wrong. Please try again.', type: 'error' });
      setBusy(false);
    }
  }

  const itemCount = items.length === 1 ? '1 NFT' : `${items.length} NFTs`;
  const isDisabled = busy;

  if (step === 'loading') {
    return (
      <div style={styles.container}>
        <img src="https://res.cloudinary.com/dkapdtxek/image/upload/SC_small.svg" alt="Stiff Competition" style={{ maxWidth: 200, marginBottom: 20 }} />
        <p>Loading your order...</p>
      </div>
    );
  }

  if (step === 'error') {
    return (
      <div style={styles.container}>
        <img src="https://res.cloudinary.com/dkapdtxek/image/upload/SC_small.svg" alt="Stiff Competition" style={{ maxWidth: 200, marginBottom: 20 }} />
        <h1>Invalid or already claimed</h1>
        <p style={styles.hint}>
          If you think this is a mistake, contact us at <a href="mailto:hq@stiffcompetition.shop" style={styles.link}>hq@stiffcompetition.shop</a>.
        </p>
        {message && <div style={styles.error}>{message.text}</div>}
      </div>
    );
  }

  if (step === 'success') {
    return (
      <div style={styles.container}>
        <img src="https://res.cloudinary.com/dkapdtxek/image/upload/SC_small.svg" alt="Stiff Competition" style={{ maxWidth: 200, marginBottom: 20 }} />
        <div style={styles.success}>
          <p>🎉 Your {mintedItems.length > 1 ? 'NFTs have' : 'NFT has'} been minted and sent to your wallet!</p>
          {usedEmail && (
            <div style={{ marginTop: 12 }}>
              <strong>Your free wallet has been created.</strong>
              <div style={{ marginTop: 10 }}>
                <a href={`/my-wallet?email=${encodeURIComponent(usedEmail)}`}
                  style={{ display: 'inline-block', padding: '10px 20px', background: '#000', color: '#fff', borderRadius: 4, textDecoration: 'none', fontWeight: 'bold' }}>
                  Access My Wallet ↗
                </a>
              </div>
            </div>
          )}
          {mintedItems.length > 0 && (
            <div style={{ marginTop: 12 }}>
              {mintedItems.map((item, i) => (
                <a key={i} href={item.openseaUrl} target="_blank" rel="noreferrer" style={styles.nftLink}>
                  {item.name} — View on OpenSea ↗
                </a>
              ))}
            </div>
          )}
        </div>
        {usedEmail && (
          <p style={styles.bookmark}>
            💡 Bookmark your wallet page — sign in anytime with <strong>{usedEmail}</strong>, no password needed.
            {walletAddr && (
              <>
                <br />Your wallet address: <strong style={{ fontSize: 11, wordBreak: 'break-all' }}>{walletAddr}</strong>
              </>
            )}
            <br /><br />We've emailed you the link as well, so you don't need to remember it.
          </p>
        )}
      </div>
    );
  }

  if (step === 'otp') {
    return (
      <div style={styles.container}>
        <img src="https://res.cloudinary.com/dkapdtxek/image/upload/SC_small.svg" alt="Stiff Competition" style={{ maxWidth: 200, marginBottom: 20 }} />
        <h1>Check your email</h1>
        <p style={{ margin: '10px 0', color: '#555' }}>
          We sent a 6-digit verification code to <strong>{pendingEmail}</strong>. Please check your inbox (and spam folder). The code expires in 10 minutes.
        </p>
        <input
          style={styles.otpInput}
          type="text"
          placeholder="Enter your 6-digit code"
          maxLength={6}
          value={otpCode}
          onChange={e => setOtpCode(e.target.value.replace(/\D/g, ''))}
        />
        <button style={isDisabled ? styles.buttonDisabled : styles.button} onClick={verifyOTP} disabled={isDisabled}>
          Verify &amp; Claim My NFT
        </button>
        <button style={isDisabled ? styles.buttonDisabled : styles.buttonBack} onClick={() => { setStep('choose'); setOtpCode(''); setMessage(null); }} disabled={isDisabled}>
          ← Back
        </button>
        {message && <div style={styles[message.type] || styles.info}>{message.text}</div>}
      </div>
    );
  }

  // step === 'choose'
  return (
    <div style={styles.container}>
      <img src="https://res.cloudinary.com/dkapdtxek/image/upload/SC_small.svg" alt="Stiff Competition" style={{ maxWidth: 200, marginBottom: 20 }} />
      <h1>🎉 Claim Your {itemCount}</h1>
      <p style={{ margin: '10px 0' }}>
        You've purchased {itemCount} from Stiff Competition! Choose how you'd like to receive {items.length === 1 ? 'it' : 'them'}.
      </p>
      <ul style={styles.ul}>
        {items.map((name, i) => <li key={i}>{name}</li>)}
      </ul>

      <h3 style={{ marginTop: 20 }}>I have a crypto wallet</h3>
      <p style={styles.hint}>
        Confirm the email address on your order{emailHint ? <> (<strong>{emailHint}</strong>)</> : null}, then tell us where to send your NFT.
      </p>
      <input
        style={styles.input}
        type="email"
        placeholder="Email address on your order"
        value={walletEmail}
        onChange={e => setWalletEmail(e.target.value)}
      />
      <input
        style={styles.input}
        type="text"
        placeholder="Enter your wallet address (0x...)"
        value={walletAddress}
        onChange={e => setWalletAddress(e.target.value)}
      />
      <button style={isDisabled ? styles.buttonDisabled : styles.button} onClick={claimWithWallet} disabled={isDisabled}>
        Claim to My Wallet
      </button>

      <div style={styles.or}>— OR —</div>

      <h3>Create a free wallet with my email</h3>
      <p style={styles.hint}>
        No crypto knowledge needed. We'll create a secure digital wallet for you, send your NFT to it, and you can view, trade and manage it using your email address.
        {emailHint ? <> Please use the address on your order (<strong>{emailHint}</strong>).</> : null}
      </p>
      <input
        style={styles.input}
        type="email"
        placeholder="Enter your email address"
        value={email}
        onChange={e => setEmail(e.target.value)}
      />
      <button style={isDisabled ? styles.buttonDisabled : styles.button} onClick={sendOTP} disabled={isDisabled}>
        Send Verification Code
      </button>

      {message && <div style={styles[message.type] || styles.info}>{message.text}</div>}
    </div>
  );
}
