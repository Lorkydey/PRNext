import type { FormHTMLAttributes, ReactElement, RefAttributes } from 'react';
export type FormProps = Omit<FormHTMLAttributes<HTMLFormElement>, 'action' | 'method' | 'encType' | 'target'> & {
  action: string | ((data: FormData) => void | Promise<void>);
  replace?: boolean;
  scroll?: boolean;
  prefetch?: false | null;
};
declare function Form(props: FormProps & RefAttributes<HTMLFormElement>): ReactElement;
export default Form;
