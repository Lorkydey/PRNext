'use client';
import { useState } from 'react';

export default function ClientFailure() {
  const [failed, setFailed] = useState(false);
  if (failed) throw new Error('Example client failure');
  return <button onClick={() => setFailed(true)}>Trigger client failure</button>;
}
