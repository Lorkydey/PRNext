'use client';

import ErrorPage from '../failure/error';

export default function ClientError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorPage error={error} retry={reset} />;
}
