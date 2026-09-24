'use client';

export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <section><h1>Something went wrong</h1><p data-testid="error-message">{error.message}</p><p data-testid="error-digest">{error.digest || 'client error'}</p><button onClick={retry}>Retry page</button></section>;
}
