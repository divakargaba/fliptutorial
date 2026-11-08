// Lane B2 owns this entrypoint (the toolbar popup hosts the profile page).
import { createRoot } from 'react-dom/client';
import { ProfilePage } from '../../src/profile-ui';
import '../../src/ui/theme.css';

createRoot(document.getElementById('root')!).render(<div className="breakpoint-shell bp-v2-popup"><ProfilePage /></div>);
