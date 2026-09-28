import ErrorPage, { type ErrorProps } from '@thomas.f/prnext/error';
import NextError from 'next/error';
import type { NextPage, NextPageContext } from '@thomas.f/prnext';

const CustomError: NextPage<ErrorProps & { source: string }> = ({ statusCode, source }) =>
  <ErrorPage statusCode={statusCode} title={source} />;
CustomError.getInitialProps = async (context: NextPageContext) => {
  context.res?.setHeader('x-custom-error', 'yes');
  const incoming: string | undefined = context.req?.url;
  const code: number | undefined = context.err?.statusCode;
  const tree = <context.AppTree pageProps={{ incoming, code }} />;
  void tree;
  return { ...await NextError.getInitialProps(context), source: context.pathname };
};

const views = <>
  <ErrorPage statusCode={404} />
  <NextError statusCode={500} title="Unavailable" withDarkMode={false} />
  <CustomError statusCode={404} source="custom" />
</>;
void views;

// @ts-expect-error HTTP status must be a number.
const invalidStatus = <ErrorPage statusCode="404" />;
// @ts-expect-error ErrorPage requires a status prop, as does Next's public component type.
const missingStatus = <NextError />;
// @ts-expect-error An error hook receives a context with a router pathname and AppTree.
ErrorPage.getInitialProps({ query: {} });
void [invalidStatus, missingStatus];
