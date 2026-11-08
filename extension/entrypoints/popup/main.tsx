// Lane B2 owns this entrypoint (the toolbar popup hosts the profile page).
import { createRoot } from 'react-dom/client';
import { ProfilePage } from '../../src/profile-ui';

createRoot(document.getElementById('root')!).render(<ProfilePage />);
