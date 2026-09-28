import Document, { Html, Head, Main, NextScript, type DocumentContext, type DocumentInitialProps, type DocumentProps } from 'next/document';
import PRNextDocument from '@thomas.f/prnext/document';

class CustomDocument extends Document<{ locale: string }> {
  static async getInitialProps(context: DocumentContext): Promise<DocumentInitialProps & { locale: string }> {
    const renderPage = context.renderPage;
    context.renderPage = () => renderPage({ enhanceApp: App => props => <App {...props} />, enhanceComponent: Page => props => <Page {...props} /> });
    context.res?.setHeader('x-document-types', 'yes');
    const props = await Document.getInitialProps(context);
    const defaults: DocumentInitialProps = await context.defaultGetInitialProps(context);
    void defaults;
    return { ...props, locale: 'fr', styles: <>{props.styles}<style>{'body{color:black}'}</style></> };
  }
  render() {
    return <Html lang={this.props.locale}><Head nonce="document-nonce" crossOrigin="anonymous"/><body><Main/><NextScript nonce="document-nonce" crossOrigin="anonymous"/></body></Html>;
  }
}
const base: typeof Document = PRNextDocument;
const extract = (props: DocumentProps) => [props.html, props.head, props.styles];
void [CustomDocument, base, extract];

// @ts-expect-error renderPage enhancers must return components.
const invalid: DocumentContext['renderPage'] = () => ({ html: 4 });
// @ts-expect-error Html uses normal HTML attributes.
const wrong = <Html lang={42}/>;
void [invalid, wrong];
