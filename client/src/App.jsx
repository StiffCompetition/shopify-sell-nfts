import React from 'react';
import ClaimPage from './ClaimPage.jsx';

export default function App() {
  // Extract orderId from URL path /claim/order/:orderId
  const match = window.location.pathname.match(/\/claim\/order\/([^/]+)/);
  const orderId = match ? match[1] : null;

  if (!orderId) {
    return (
      <div style={{ maxWidth: 500, margin: '50px auto', padding: 20, textAlign: 'center' }}>
        <h1>Invalid claim link</h1>
      </div>
    );
  }

  return <ClaimPage orderId={orderId} />;
}
