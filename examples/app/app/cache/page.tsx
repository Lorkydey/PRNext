import { readMessage } from '../../lib/cached-message';
import { saveMessage } from './actions';

export const metadata = { title: 'Shared cache · Rustyx' };

export default async function CachePage() {
  const data = await readMessage();
  return <>
    <p className="eyebrow">APP ROUTER / DATA CACHE</p>
    <h1>Read once. Share across requests.</h1>
    <p className="intro">Refresh the page: the stored message and its read time stay cached for a minute. Saving a message invalidates its tag and displays the new value immediately.</p>
    <p data-testid="cached-message">{data.message}</p>
    <p>Read from storage at <time>{data.readAt}</time></p>
    <form action={saveMessage}>
      <label>Message <input name="message" defaultValue={data.message} maxLength={100} required /></label>
      <button type="submit">Save message</button>
    </form>
  </>;
}
