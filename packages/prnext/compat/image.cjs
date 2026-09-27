'use client';
'use strict';
const React = require('react');
const ReactDOM = require('react-dom');
const {imageProps,getImageProps,placeholderStyle}=require('./image-shared.cjs');
const useBrowserLayoutEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;
const Image = React.forwardRef(function Image(input, ref) {
  const result = imageProps(input);
  const [complete, setComplete] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const internalRef = React.useRef(null);
  const retriedRef = React.useRef(null);
  const latest = React.useRef(result);
  latest.current = result;
  const loaded = React.useCallback(image => {
    if (!image || image.naturalWidth === 0 || image.dataset.loadedSrc === image.src) return;
    const source = image.src;
    image.dataset.loadedSrc = image.src;
    Promise.resolve(image.decode?.()).catch(() => {}).then(() => {
      if (!image.isConnected || image.naturalWidth === 0 || image.src !== source) return;
      setComplete(true);
      const { onLoad, onLoadingComplete } = latest.current;
      if (onLoad) {
        const event = new Event('load');
        Object.defineProperty(event, 'target', { value: image });
        onLoad({ ...event, type: 'load', nativeEvent: event, currentTarget: image, target: image, persist() {}, isDefaultPrevented: () => event.defaultPrevented, isPropagationStopped: () => false, preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation() });
      }
      onLoadingComplete?.(image);
    });
  }, []);
  const attach = React.useCallback(image => {
    internalRef.current = image;
    const cleanup = typeof ref === 'function' ? ref(image) : undefined;
    if (ref && typeof ref !== 'function') ref.current = image;
    if (image?.complete) loaded(image);
    if (image) return () => {
      internalRef.current = null;
      if (typeof cleanup === 'function') cleanup();
      else if (typeof ref === 'function') ref(null);
      else if (ref) ref.current = null;
    };
  }, [ref, loaded]);
  useBrowserLayoutEffect(() => {
    const image = internalRef.current;
    if (!image?.complete || image.naturalWidth !== 0 || !image.getAttribute('src')) return;
    // Native error events that precede hydration are not replayed by React.
    // Retry after handlers are attached so onError receives a real image event.
    if (latest.current.onError && retriedRef.current !== image) {
      retriedRef.current = image;
      image.src = image.src;
    } else {
      setComplete(true);
      setFailed(true);
    }
  }, []);
  if (result.priority && ReactDOM.preload) ReactDOM.preload(result.props.src, { as: 'image', imageSrcSet: result.props.srcSet, imageSizes: result.props.sizes, crossOrigin: result.props.crossOrigin, referrerPolicy: result.props.referrerPolicy, fetchPriority: result.props.fetchPriority });
  return React.createElement('img', { ...result.props,
    style: { ...result.props.style, ...(complete ? {} : placeholderStyle(result)), ...(failed ? { color: undefined } : {}) }, ref: attach,
    onLoad: event => loaded(event.currentTarget), onError: event => { setComplete(true); setFailed(true); result.onError?.(event); },
  });
});
module.exports = Image;
module.exports.default = Image;
module.exports.getImageProps = getImageProps;
