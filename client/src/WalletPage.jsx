import React from 'react';
import { createThirdwebClient } from 'thirdweb';
import { ConnectButton, ThirdwebProvider } from 'thirdweb/react';
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

const styles = {
  container: {
    fontFamily: 'Arial, sans-serif',
    maxWidth: 500,
    margin: '50px auto',
    padding: 20,
    textAlign: 'center',
  },
};

export default function WalletPage() {
  return (
    <ThirdwebProvider>
      <div style={styles.container}>
        <img
          src="https://res.cloudinary.com/dkapdtxek/image/upload/SC_small.svg"
          alt="Stiff Competition"
          style={{ maxWidth: 200, marginBottom: 20 }}
        />
        <h1 style={{ marginBottom: 10 }}>Your Stiff Competition Wallet</h1>
        <p style={{ color: '#555', marginBottom: 30, fontSize: 14 }}>
          Sign in with your email to access your wallet, view your NFTs, and connect to OpenSea and Discord.
        </p>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <ConnectButton
            client={client}
            wallets={wallets}
            chain={polygon}
            theme="light"
            connectButton={{
              label: 'Sign In With Email',
            }}
            detailsModal={{
              assetTabs: ['nft', 'token'],
            }}
            supportedNFTs={{
              [polygon.id]: [
                '0xBB9a30909396A055c64F2e3FB0E9C299B3fdbd4C',
              ],
            }}
            appMetadata={{
              name: 'Stiff Competition',
              logoUrl: 'https://res.cloudinary.com/dkapdtxek/image/upload/SC_small.svg',
            }}
          />
        </div>
      </div>
    </ThirdwebProvider>
  );
}
