// Class-based drug-drug interaction rules: each rule names two drug classes
// (lists of generic ingredient names), so it applies to every drug in them
// and every brand/strength whose name contains the ingredient. Drawn from
// well-established high-priority interactions (the ONC High-Priority DDI
// list, FDA boxed warnings, and AGS Beers Criteria drug-drug items).
// A decision aid, not exhaustive: it does not replace a pharmacist review.

export type Severity = "high" | "moderate";

export interface InteractionRule {
  a: string[];
  b: string[];
  severity: Severity;
  description: string;
}

const NSAIDS = [
  "ibuprofen", "naproxen", "diclofenac", "meloxicam", "celecoxib", "indomethacin", "ketorolac", "etodolac",
  "nabumetone", "piroxicam", "sulindac", "oxaprozin", "ketoprofen", "flurbiprofen", "fenoprofen",
  "mefenamic acid", "diflunisal",
];
const ANTIPLATELETS = ["aspirin", "clopidogrel", "prasugrel", "ticagrelor", "ticlopidine", "dipyridamole", "cilostazol"];
const WARFARIN = ["warfarin"];
const DOACS = ["apixaban", "rivaroxaban", "dabigatran", "edoxaban"];
const ANTICOAGULANTS = [...WARFARIN, ...DOACS, "enoxaparin", "dalteparin", "fondaparinux"];
const ACE_INHIBITORS = [
  "lisinopril", "enalapril", "ramipril", "benazepril", "captopril", "quinapril", "fosinopril", "perindopril",
  "trandolapril", "moexipril",
];
const ARBS = [
  "losartan", "valsartan", "irbesartan", "olmesartan", "candesartan", "telmisartan", "azilsartan", "eprosartan",
];
const POTASSIUM_SPARING = ["spironolactone", "eplerenone", "amiloride", "triamterene", "finerenone"];
// Whole phrases, so "losartan potassium" is not mistaken for a supplement.
const POTASSIUM_SUPPLEMENTS = ["potassium chloride", "potassium citrate", "potassium bicarbonate", "klor-con", "k-tab"];
const THIAZIDES = ["hydrochlorothiazide", "chlorthalidone", "indapamide", "metolazone", "chlorothiazide"];
const OPIOIDS = [
  "oxycodone", "hydrocodone", "morphine", "hydromorphone", "oxymorphone", "fentanyl", "methadone", "tramadol",
  "tapentadol", "codeine", "buprenorphine", "meperidine",
];
const BENZODIAZEPINES = [
  "alprazolam", "lorazepam", "clonazepam", "diazepam", "temazepam", "chlordiazepoxide", "clorazepate", "oxazepam",
  "triazolam", "midazolam", "estazolam",
];
const Z_DRUGS = ["zolpidem", "eszopiclone", "zaleplon"];
const GABAPENTINOIDS = ["gabapentin", "pregabalin"];
const MAOIS = [
  "phenelzine", "tranylcypromine", "isocarboxazid", "selegiline", "rasagiline", "safinamide", "linezolid",
  "methylene blue",
];
const SSRIS = ["fluoxetine", "sertraline", "paroxetine", "citalopram", "escitalopram", "fluvoxamine", "vilazodone", "vortioxetine"];
const SNRIS = ["venlafaxine", "desvenlafaxine", "duloxetine", "levomilnacipran", "milnacipran"];
const TRIPTANS = ["sumatriptan", "rizatriptan", "zolmitriptan", "eletriptan", "naratriptan", "almotriptan", "frovatriptan"];
const SEROTONERGIC = [
  ...SSRIS, ...SNRIS, ...TRIPTANS, "tramadol", "meperidine", "methadone", "fentanyl", "dextromethorphan",
  "trazodone", "mirtazapine", "buspirone", "lithium", "amitriptyline", "nortriptyline", "imipramine",
  "clomipramine", "desipramine", "doxepin", "st. john's wort",
];
const SIMVA_LOVA = ["simvastatin", "lovastatin"];
const STRONG_CYP3A4_INHIBITORS = [
  "clarithromycin", "erythromycin", "itraconazole", "ketoconazole", "posaconazole", "voriconazole", "ritonavir",
  "cobicistat", "nefazodone",
];
const NITRATES = ["nitroglycerin", "isosorbide mononitrate", "isosorbide dinitrate"];
const PDE5_INHIBITORS = ["sildenafil", "tadalafil", "vardenafil", "avanafil"];
const DIGOXIN_RAISERS = ["amiodarone", "dronedarone", "verapamil", "quinidine", "clarithromycin", "propafenone"];
const QT_PROLONGING = [
  "amiodarone", "sotalol", "dofetilide", "dronedarone", "quinidine", "citalopram", "escitalopram", "haloperidol",
  "methadone", "ondansetron", "azithromycin", "clarithromycin", "erythromycin", "levofloxacin", "moxifloxacin",
  "hydroxychloroquine", "chloroquine", "quetiapine", "ziprasidone", "pimozide", "thioridazine", "donepezil",
  "fluconazole",
];
const STRONG_ANTICHOLINERGICS = [
  "diphenhydramine", "hydroxyzine", "doxylamine", "chlorpheniramine", "promethazine", "meclizine", "oxybutynin",
  "tolterodine", "solifenacin", "trospium", "darifenacin", "fesoterodine", "amitriptyline", "nortriptyline",
  "imipramine", "doxepin", "paroxetine", "benztropine", "trihexyphenidyl", "cyclobenzaprine", "dicyclomine",
  "hyoscyamine", "scopolamine", "olanzapine", "clozapine",
];

export const INTERACTION_RULES: InteractionRule[] = [
  { a: WARFARIN, b: NSAIDS, severity: "high", description: "Serious bleeding risk: NSAID pain relievers with warfarin." },
  { a: ANTICOAGULANTS, b: ANTIPLATELETS, severity: "high", description: "Higher bleeding risk: blood thinner with an antiplatelet drug (including aspirin)." },
  { a: DOACS, b: NSAIDS, severity: "high", description: "Higher bleeding risk: NSAID pain relievers with a blood thinner." },
  { a: ANTICOAGULANTS, b: ANTICOAGULANTS, severity: "high", description: "Two blood thinners together: serious bleeding risk." },
  { a: WARFARIN, b: ["fluconazole", "miconazole", "metronidazole", "sulfamethoxazole", "amiodarone"], severity: "high", description: "Raises warfarin's effect: bleeding risk. INR needs close monitoring." },
  { a: [...ACE_INHIBITORS, ...ARBS], b: [...POTASSIUM_SPARING, ...POTASSIUM_SUPPLEMENTS], severity: "high", description: "Risk of dangerously high potassium (hyperkalemia)." },
  { a: ACE_INHIBITORS, b: ARBS, severity: "moderate", description: "ACE inhibitor with an ARB: more kidney problems and high potassium, usually without added benefit." },
  { a: [...ACE_INHIBITORS, ...ARBS], b: NSAIDS, severity: "moderate", description: "NSAIDs can reduce blood-pressure control and harm the kidneys with this medicine." },
  { a: POTASSIUM_SPARING, b: POTASSIUM_SUPPLEMENTS, severity: "high", description: "Risk of dangerously high potassium (hyperkalemia)." },
  { a: OPIOIDS, b: BENZODIAZEPINES, severity: "high", description: "FDA boxed warning: opioid with a benzodiazepine can cause deep sedation, slowed breathing and death." },
  { a: OPIOIDS, b: GABAPENTINOIDS, severity: "high", description: "FDA warning: opioid with gabapentin/pregabalin can cause dangerously slowed breathing." },
  { a: OPIOIDS, b: Z_DRUGS, severity: "high", description: "Opioid with a sleep medicine: deep sedation and slowed breathing." },
  { a: BENZODIAZEPINES, b: Z_DRUGS, severity: "moderate", description: "Two sedatives: drowsiness, confusion and falls, especially in older adults." },
  { a: MAOIS, b: SEROTONERGIC, severity: "high", description: "Risk of serotonin syndrome, which can be life-threatening." },
  { a: [...SSRIS, ...SNRIS], b: ["tramadol", "linezolid"], severity: "high", description: "Risk of serotonin syndrome (and seizures with tramadol)." },
  { a: [...SSRIS, ...SNRIS], b: [...NSAIDS, ...ANTICOAGULANTS, "aspirin", "clopidogrel"], severity: "moderate", description: "Higher risk of bleeding, especially stomach bleeding." },
  { a: SIMVA_LOVA, b: [...STRONG_CYP3A4_INHIBITORS, "gemfibrozil"], severity: "high", description: "Raises statin levels: risk of serious muscle damage (rhabdomyolysis)." },
  { a: PDE5_INHIBITORS, b: NITRATES, severity: "high", description: "Can cause a sudden, dangerous drop in blood pressure." },
  { a: ["digoxin"], b: DIGOXIN_RAISERS, severity: "high", description: "Raises digoxin levels: risk of digoxin toxicity." },
  { a: ["lithium"], b: [...ACE_INHIBITORS, ...ARBS, ...THIAZIDES, ...NSAIDS], severity: "high", description: "Raises lithium levels: risk of lithium toxicity." },
  { a: ["methotrexate"], b: ["trimethoprim", "sulfamethoxazole"], severity: "high", description: "Risk of severe methotrexate toxicity (bone marrow suppression)." },
  { a: ["methotrexate"], b: NSAIDS, severity: "moderate", description: "NSAIDs can raise methotrexate levels." },
  { a: ["tizanidine"], b: ["ciprofloxacin", "fluvoxamine"], severity: "high", description: "Greatly raises tizanidine levels: severe low blood pressure and sedation." },
  { a: ["theophylline"], b: ["ciprofloxacin", "fluvoxamine"], severity: "high", description: "Raises theophylline levels: risk of toxicity." },
  { a: ["colchicine"], b: [...STRONG_CYP3A4_INHIBITORS, "cyclosporine"], severity: "high", description: "Raises colchicine levels: risk of fatal colchicine toxicity." },
  { a: ["allopurinol", "febuxostat"], b: ["azathioprine", "mercaptopurine"], severity: "high", description: "Risk of severe azathioprine/mercaptopurine toxicity." },
  { a: ["clopidogrel"], b: ["omeprazole", "esomeprazole"], severity: "moderate", description: "May make clopidogrel less effective at preventing clots." },
  { a: QT_PROLONGING, b: QT_PROLONGING, severity: "moderate", description: "Two medicines that can affect heart rhythm (QT prolongation)." },
  { a: STRONG_ANTICHOLINERGICS, b: STRONG_ANTICHOLINERGICS, severity: "moderate", description: "Two strongly anticholinergic medicines: confusion, constipation and falls in older adults (Beers Criteria)." },
];
