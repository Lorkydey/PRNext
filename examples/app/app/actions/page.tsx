import { cookies } from 'next/headers';
import ActionClient from './client';
import { saveName, redirectAfterSave } from './actions';

export const metadata = { title: 'Server Actions · PRNext' };

export default async function ActionsPage() {
  const store = await cookies();
  const record = { id: 'record-42', token: 'PRNEXT_ACTION_CLOSURE_SECRET' };
  async function saveBound(data: FormData) {
    'use server';
    if (record.token !== 'PRNEXT_ACTION_CLOSURE_SECRET') throw new Error('Invalid record');
    const value = String(data.get('value') || '').slice(0, 40);
    (await cookies()).set('rx-bound', `${record.id}:${value}`, { httpOnly: true, sameSite: 'lax' });
  }
  return <>
    <p className="eyebrow">APP ROUTER / SERVER ACTIONS</p>
    <h1>Write on the server.</h1>
    <p className="intro">Forms and buttons call server functions, then refresh this page's data while preserving the layout.</p>
    <p data-testid="server-count">{store.get('rx-count')?.value || '0'}</p>
    <p data-testid="server-name">{store.get('rx-name')?.value || 'Anonymous'}</p>
    <p data-testid="server-bound">{store.get('rx-bound')?.value || 'No bound update'}</p>
    <p data-testid="server-redirect">{store.get('rx-redirect')?.value || 'No redirect yet'}</p>
    <ActionClient />
    <form action={saveName}><label>Name <input name="name" defaultValue="Grace" /></label><button type="submit">Save name</button></form>
    <form action={saveBound}><label>Record value <input name="value" defaultValue="updated" /></label><button type="submit">Save bound record</button></form>
    <form action={redirectAfterSave}><button type="submit">Save and redirect</button></form>
  </>;
}
