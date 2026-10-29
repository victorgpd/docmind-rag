import { demoEnabledOnServer } from '../../src/lib/demo-server';
import { AuthPage } from '../../src/components/AuthPage';

export default async function Page() {
  return <AuthPage mode="login" demoEnabled={await demoEnabledOnServer()} />;
}
