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
  success: { marginTop: 20, padding: 15, borderRadius: 4, background: '#d4edda', color: '#155724', lineHeight: 1.6 },
  error: { marginTop: 20, padding: 15, borderRadius: 4, background: '#f8d7da', color: '#721c24' },
  info: { marginTop: 20, padding: 15, borderRadius: 4, background: '#d1ecf1', color: '#0c5460' },
  otpInput: { width: '100%', padding: 12, margin: '10px 0', border: '1px solid #ccc', borderRadius: 4, boxSizing: 'border-box', fontSize: 20, letterSpacing: 6, textAlign: 'center' },
  walletBox: { marginTop: 20, padding: 15, background: '#f8f9fa', borderRadius: 4, textAlign: 'left', wordBreak: 'break-all', fontSize: 13 },
};

export default function WalletPage() {
  const params = new URLSearchParams(window.location.search);
  const prefillEmail = params.get('email') || '';

  const [step, setStep] = useState('email'); // email, otp, connected
  const [email, setEmail] = useState(prefillEmail);
  const [otpCode, setOtpCode] = useState('');
  const [walletAddress, setWalletAddress] = useState('');
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  // Auto-send OTP if email is prefilled
  useEffect(() => {
    if (prefillEmail) {
      sendOTP(prefillEmail);
    }
  }, []);

  async function sendOTP(emailToSend) {
    const target = emailToSend || email.trim();
    if (!target) { setMessage({ text: 'Please enter your email address', type: 'error' }); return; }
    setBusy(true);
    setMessage({ text: 'Sending your verification code...', type: 'info' });
    try {
      await preAuthenticate({ client, strategy: 'email', email: target });
      setEmail(target);
      setStep('otp');
      setMessage({ text: `We sent a 6-digit code to ${target}. Check your inbox (and spam folder).`, type: 'info' });
    } catch (e) {
      setMessage({ text: 'Could not send verification code. Please try again.', type: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function verifyOTP() {
    if (!otpCode || otpCode.length < 6) { setMessage({ text: 'Please enter the 6-digit code', type: 'error' }); return; }
    setBusy(true);
    setMessage({ text: 'Verifying...', type: 'info' });
    try {
      const wallet = inAppWallet();
      const account = await wallet.connect({
        client,
        chain: polygon,
        strategy: 'email',
        email,
        verificationCode: otpCode,
      });
      setWalletAddress(account.address);
      setStep('connected');
      setMessage(null);
    } catch (e) {
      setMessage({ text: 'Invalid code — please try again', type: 'error' });
      setBusy(false);
    }
  }

  if (step === 'connected') {
    return (
      <div style={styles.container}>
        <img src="https://res.cloudinary.com/dkapdtxek/image/upload/SC_small.svg" alt="Stiff Competition" style={{ maxWidth: 200, marginBottom: 20 }} />
        <h1>✅ Wallet Connected</h1>
        <p style={{ margin: '15px 0', color: '#555' }}>You're signed in as <strong>{email}</strong>.</p>
        <div style={styles.walletBox}>
          <strong>Your wallet address:</strong><br />
          <span>{walletAddress}</span>
        </div>
        <p style={{ margin: '20px 0 10px', color: '#555', fontSize: 14 }}>
          Use this wallet to view your NFTs on OpenSea, connect to token-gated experiences, and more.
        </p>
        <a href={`https://opensea.io/${walletAddress}`} target="_blank" rel="noreferrer"
          style={{ display: 'block', padding: 12, background: '#000', color: '#fff', borderRadius: 4, textDecoration: 'none', margin: '5px 0', fontSize: 16 }}>
          View My NFTs on OpenSea ↗
        </a>
      </div>
    );
  }

  if (step === 'otp') {
    return (
      <div style={styles.container}>
        <img src="https://res.cloudinary.com/dkapdtxek/image/upload/SC_small.svg" alt="Stiff Competition" style={{ maxWidth: 200, marginBottom: 20 }} />
        <h1>Check your email</h1>
        {message && <div style={styles[message.type]}>{message.text}</div>}
        <input
          style={styles.otpInput}
          type="text"
          placeholder="000000"
          maxLength={6}
          value={otpCode}
          onChange={e => setOtpCode(e.target.value.replace(/\D/g, ''))}
        />
        <button style={busy ? styles.buttonDisabled : styles.button} onClick={verifyOTP} disabled={busy}>
          Access My Wallet
        </button>
        <button style={{ ...styles.button, background: '#555', marginTop: 5 }} onClick={() => { setStep('email'); setOtpCode(''); setMessage(null); }}>
          ← Back
        </button>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <img src="https://res.cloudinary.com/dkapdtxek/image/upload/SC_small.svg" alt="Stiff Competition" style={{ maxWidth: 200, marginBottom: 20 }} />
      <h1>Access Your Wallet</h1>
      <p style={{ margin: '15px 0', color: '#555' }}>Sign in with your email to access your Stiff Competition wallet and NFTs.</p>
      <input
        style={styles.input}
        type="email"
        placeholder="Enter your email address"
        value={email}
        onChange={e => setEmail(e.target.value)}
      />
      <button style={busy ? styles.buttonDisabled : styles.button} onClick={() => sendOTP()} disabled={busy}>
        Send Verification Code
      </button>
      {message && <div style={styles[message.type]}>{message.text}</div>}
    </div>
  );
}
