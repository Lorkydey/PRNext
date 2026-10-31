import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { desc, eq } from 'drizzle-orm';
import { getAuth } from '../../../lib/auth.js';
import { getDatabase, notes } from '../../../lib/database.js';
import { NoteForm, SessionForm } from '../../forms.jsx';
import { deleteNote, signOut } from '../../actions.js';

export default async function Dashboard({ params }) {
  const { locale } = await params, t = await getTranslations('App');
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect('/' + locale + '/sign-in');
  const items = await getDatabase().select().from(notes).where(eq(notes.userId, session.user.id)).orderBy(desc(notes.createdAt)).limit(100);
  return <main id="main"><h1>{t('title')}</h1><p data-testid="account">{t('signedIn', { email: session.user.email })}</p>
    <NoteForm locale={locale} /><section aria-labelledby="notes-title"><h2 id="notes-title">{t('notes')}</h2>
      {items.length ? <ul className="notes">{items.map(note => <li key={note.id}><p>{note.body}</p><form action={deleteNote}>
        <input type="hidden" name="locale" value={locale} /><input type="hidden" name="id" value={note.id} />
        <button>{t('remove')}</button></form></li>)}</ul> : <p>{t('empty')}</p>}
    </section><section aria-labelledby="account-title"><h2 id="account-title">{t('account')}</h2><SessionForm locale={locale} />
      <form action={signOut}><input type="hidden" name="locale" value={locale} /><button>{t('signOut')}</button></form>
    </section>
  </main>;
}
