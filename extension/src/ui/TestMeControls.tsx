import { useContext, useEffect, useRef } from 'react';
import { CircleAlert, LoaderCircle, Play, Sparkles, X } from 'lucide-react';
import { TestMeContext } from '../test-me';
import { BrandMark } from './BrandMark';

const ERRORS: Record<string, { title: string; action: string }> = {
  NO_CAPTIONS: { title: 'No English captions', action: 'Try a coding tutorial with English captions.' },
  // Backend code kept for compatibility: the taught language isn't one Test me can grade yet.
  NOT_PYTHON: { title: 'Not a supported language yet', action: 'Try a tutorial teaching Python, JavaScript, Java or C++.' },
  TOO_EARLY: { title: 'A little more to learn first', action: 'Keep watching until a concept is explained, then try Test me again. There is no fixed waiting time.' },
  NOT_FOUND: { title: 'Test me is turned off on the server', action: 'Restart the backend with the latest version, or remove its BREAKPOINT_TESTME=false override.' },
  GENERATOR_UNAVAILABLE: { title: 'Practice generation unavailable', action: 'Try again, or resume the video.' },
  GENERATOR_TIMEOUT: { title: 'Practice generation timed out', action: 'Try again, or resume the video.' },
  BUSY: { title: 'Practice generation is busy', action: 'Wait a minute before trying again, or resume the video.' },
  NETWORK: { title: 'Can’t reach Breakpoint', action: 'Check that the local backend is running, then try again.' },
  TIMEOUT: { title: 'Request timed out', action: 'Try again, or resume the video.' },
};

/** Mount beside the prepared badge, including on unsupported/unprepared videos. */
export function TestMeControls() {
  const context = useContext(TestMeContext);
  const heading = useRef<HTMLHeadingElement>(null);
  const start = useRef<HTMLButtonElement>(null);
  const status = context?.request?.status;
  useEffect(() => {
    if (!status) return;
    heading.current?.focus({ preventScroll: true });
    return () => { if (start.current?.isConnected) start.current.focus({ preventScroll: true }); };
  }, [status]);
  if (!context) return null;
  const { canStart, request, onStart, onRetry, onClose } = context;
  const error = request?.status === 'error' ? request.error : null;
  const description = error ? ERRORS[error.code] : null;
  return <div className="bp-test-me">
    <button ref={start} type="button" className="bp-badge bp-test-me-trigger" aria-label="Test me" disabled={!canStart} aria-disabled={!canStart || undefined} onClick={onStart}
      title="Create practice from what you have watched so far">
      <Sparkles size={15} aria-hidden="true" />Test me<span className="bp-bonus-tag" aria-hidden="true">Bonus</span>
    </button>
    {request && <section className="bp-panel bp-generation" aria-labelledby="bp-generation-heading">
      <header className="bp-header">
        <BrandMark size={16} />
        <span className="bp-generated-label"><Sparkles size={12} aria-hidden="true" />AI-generated practice</span>
        <button type="button" className="bp-icon-button" aria-label="Close generated practice" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <div className="bp-body" aria-live="polite" aria-atomic="true">
        <h2 id="bp-generation-heading" ref={heading} tabIndex={-1}>
          {error ? description?.title ?? 'Practice unavailable' : 'Creating your practice…'}
        </h2>
        {error ? <>
          <p className="bp-generation-message"><CircleAlert size={16} aria-hidden="true" />{error.message}</p>
          <p className="bp-note">{description?.action ?? 'Close this panel to resume watching.'}</p>
        </> : <>
          <p className="bp-generation-message" role="status"><LoaderCircle size={16} className="bp-spin" aria-hidden="true" />
            Making one extra challenge from what has been taught up to this moment.</p>
          <p className="bp-note">Your video is paused. This can take up to 20 seconds.</p>
        </>}
      </div>
      <footer className="bp-footer">
        <button type="button" className="bp-skip" onClick={onClose}><Play size={14} aria-hidden="true" />Resume video</button>
        {error?.retryable && <button type="button" className="bp-button bp-primary" onClick={onRetry}>Try again</button>}
      </footer>
    </section>}
  </div>;
}
