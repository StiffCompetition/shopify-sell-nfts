import React, { useEffect, useRef } from 'react';
import { createThirdwebClient } from 'thirdweb';
import { ConnectButton, ThirdwebProvider, useActiveAccount } from 'thirdweb/react';
import { inAppWallet } from 'thirdweb/wallets';
import { polygon } from 'thirdweb/chains';

const client = createThirdwebClient({
  clientId: '5b6fea50005cae4d61448c7a4306866f',
});

const wallets = [
  inAppWallet({
    auth: {
      options: ['email'],
    },
  }),
];

const supportedNFTs = {
  [polygon.id]: ['0xBB9a30909396A055c64F2e3FB0E9C299B3fdbd4C'],
};

const styles = {
  container: {
    fontFamily: 'Arial, sans-serif',
    maxWidth: 500,
    margin: '50px auto',
    padding: 20,
    textAlign: 'center',
  },
  note: {
    marginTop: 20,
    fontSize: 13,
    color: '#777',
  },
  connectedNote: {
    marginTop: 16,
    fontSize: 13,
    color: '#555',
    lineHeight: 1.6,
  },
};

function WalletContent() {
  const account = useActiveAccount();
  const buttonRef = useRef(null);

  // Auto-click the wallet button to open details when already connected
  useEffect(() => {
    if (account && buttonRef.current) {
      const btn = buttonRef.current.querySelector('button');
      if (btn) {
        setTimeout(() => btn.click(), 300);
      }
    }
  }, [account]);

  return (
    <div style={styles.container}>
      <img
        src="https://res.cloudinary.com/dkapdtxek/image/upload/SC_small.svg"
        alt="Stiff Competition"
        style={{ maxWidth: 200, marginBottom: 20 }}
      />
      <h1 style={{ marginBottom: 8 }}>Your Stiff Competition Wallet</h1>
      <p style={{ color: '#555', marginBottom: 24, fontSize: 14 }}>
        {account
          ? 'Click the button below to view your NFTs, send, receive, and connect to OpenSea and Discord.'
          : 'Sign in with your email to access your wallet and view your NFTs.'}
      </p>
      <div style={{ display: 'flex', justifyContent: 'center' }} ref={buttonRef}>
        <ConnectButton
          client={client}
          wallets={wallets}
          chain={polygon}
          theme="light"
          connectButton={{
            label: 'Sign In With Email',
          }}
          detailsButton={{
            displayBalanceToken: {},
          }}
          detailsModal={{
            assetTabs: ['nft', 'token'],
          }}
          supportedNFTs={supportedNFTs}
          appMetadata={{
            name: 'Stiff Competition',
            logoUrl: 'https://res.cloudinary.com/dkapdtxek/image/upload/SC_small.svg',
          }}
        />
      </div>
      {account && (
        <p style={styles.connectedNote}>
          💡 Bookmark this page to access your wallet anytime.<br />
          Your wallet address: <strong style={{ fontSize: 11, wordBreak: 'break-all' }}>{account.address}</strong>
        </p>
      )}
      {!account && (
        <p style={styles.note}>
          💡 Bookmark this page — sign in anytime with your email to access your wallet.
        </p>
      )}
    </div>
  );
}

export default function WalletPage() {
  return (
    <ThirdwebProvider>
      <WalletContent />
    </ThirdwebProvider>
  );
}
