import { demoEnabledOnServer } from '../src/lib/demo-server';
import { Landing } from '../src/components/Landing';
import { LandingRedirect } from '../src/components/LandingRedirect';

export const metadata = {
  title: 'DocMind: pergunte aos seus documentos, com fontes',
  description: 'Envie seus arquivos, converse em português e receba respostas com citações verificáveis.',
};

export default async function Home() {
  const demoEnabled = await demoEnabledOnServer();
  return (
    <>
      <LandingRedirect />
      <Landing demoEnabled={demoEnabled} />
    </>
  );
}
