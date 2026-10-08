import {PageHeading} from '@/components/shell';
import {CostDashboard} from './CostDashboard';
export default function CostsPage(){return <><PageHeading eyebrow="Suivi des facturations" title="Montants facturés" description="Consultez les montants facturés en FCFA et exportez l’historique des générations."/><CostDashboard/></>}
