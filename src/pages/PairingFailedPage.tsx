import { useTranslation } from "react-i18next";
import { Callout } from "@sa/components/Callout";
import "./PairingFailedPage.css";

export function PairingFailedPage() {
  const { t } = useTranslation();
  return (
    <div className="ac-pairing">
      <Callout variant="warning" title={t("ac.pairing.failedTitle")}>
        {t("ac.pairing.failedBody")}
      </Callout>
    </div>
  );
}
