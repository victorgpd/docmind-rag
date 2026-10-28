import { Landing } from '../src/components/Landing';
import { LandingRedirect } from '../src/components/LandingRedirect';

export const metadata = {
  title: 'DocMind: pergunte aos seus documentos, com fontes',
  description: 'Envie seus arquivos, converse em português e receba respostas com citações verificáveis.',
};

export default function Home() {
  return (
    <>
      <LandingRedirect />
      <Landing />
    </>
  );
}
