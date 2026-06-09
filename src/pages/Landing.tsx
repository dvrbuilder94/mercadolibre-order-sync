import { LandingNavbar } from "@/components/landing/LandingNavbar";
import { LandingHero } from "@/components/landing/LandingHero";
import { LandingFeatures } from "@/components/landing/LandingFeatures";
import { LandingTrust } from "@/components/landing/LandingTrust";
import { LandingAudience } from "@/components/landing/LandingAudience";
import { LandingHowItWorks } from "@/components/landing/LandingHowItWorks";
import { LandingWhy } from "@/components/landing/LandingWhy";
import { LandingEarlyAccess } from "@/components/landing/LandingEarlyAccess";
import { LandingFooter } from "@/components/landing/LandingFooter";

const Landing = () => {
  return (
    <div className="min-h-screen bg-background">
      <LandingNavbar />
      <main>
        <LandingHero />
        <LandingFeatures />
        <LandingTrust />
        <LandingAudience />
        <LandingHowItWorks />
        <LandingWhy />
        <LandingEarlyAccess />
      </main>
      <LandingFooter />
    </div>
  );
};

export default Landing;
