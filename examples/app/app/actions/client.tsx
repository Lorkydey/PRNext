'use client';

import { startTransition, useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { increment, greet, failAction } from './actions';

function Submit() {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save greeting'}</button>;
}

export default function ActionClient() {
  const [result, setResult] = useState('No action yet');
  const [error, setError] = useState('');
  const [state, formAction, pending] = useActionState(greet, { message: '', submitted: 0 }, '/actions');
  return <section>
    <button onClick={() => startTransition(async () => {
      const answer = await increment(1);
      setResult(`${answer.value} / ${answer.at instanceof Date ? 'Date' : 'invalid'} / ${answer.tags.get('source')}`);
    })}>Increment on server</button>
    <p data-testid="action-result">{result}</p>
    <form action={formAction}>
      <label>Greeting name <input name="name" defaultValue="Ada" /></label>
      <Submit />
      <p data-testid="action-state">{state.message} ({state.submitted})</p>
      <p data-testid="action-pending">{String(pending)}</p>
    </form>
    <button onClick={() => startTransition(async () => {
      try { await failAction(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    })}>Test action error</button>
    <p data-testid="action-error">{error}</p>
  </section>;
}
