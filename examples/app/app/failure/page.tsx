import { cookies } from 'next/headers';
import Counter from '../../components/counter';

export default async function Failure() {
  if ((await cookies()).get('example-recovered')?.value !== '1') {
    throw new Error('Example server failure: this detail stays on the server.');
  }
  return <><h1>Recovered server page</h1><Counter initial={20} /></>;
}
