import React from 'react';
import ClaimPage from './ClaimPage.jsx';
import WalletPage from './WalletPage.jsx';

export default function App() {
  const path = window.location.pathname;

  if (path === '/my-wallet') {
    return <WalletPage />;
  }

  const match = path.match(/\/claim\/order\/([^/]+)/);
  const orderId = match ? match[1] : null;

  if (!orderId) {
    return (
      <div style={{ maxWidth: 500, margin: '50px auto', padding: 20, textAlign: 'center' }}>
        <h1>Invalid link</h1>
      </div>
    );
  }

  return <ClaimPage orderId={orderId} />;
}
