# Publier une alpha de PRNext

Le paquet JavaScript `prnext` fournit les deux exécutables `prn` et `prnext`. Ses dépendances optionnelles installent le serveur Rust correspondant à l'OS et à l'architecture de Node. Aucun téléchargement ni compilation n'est exécuté par un script `postinstall` de PRNext. Un consommateur n'a pas besoin du dépôt ni de Rust.

Cette distribution reste une **alpha très expérimentale**, avec une compatibilité Next.js partielle. La validation du paquet ne constitue pas une certification de toutes les applications Next.js.

## Plateformes de cette première distribution

| Environnement | Paquet natif | Runner de validation |
| --- | --- | --- |
| macOS Apple Silicon | `prnext-darwin-arm64` | macOS 14 arm64 |
| macOS Intel | `prnext-darwin-x64` | macOS 15 Intel |
| Linux x64 avec glibc | `prnext-linux-x64-gnu` | Ubuntu 22.04 x64 |
| Linux arm64 avec glibc | `prnext-linux-arm64-gnu` | Ubuntu 22.04 arm64 |

Node.js **22 ou supérieur** reste nécessaire pour compiler l'application et exécuter React et les modules npm. Les binaires Linux de la CI sont construits sur Ubuntu 22.04 (glibc 2.35) ; les distributions plus anciennes ne sont pas validées. Les builds macOS CI ciblent macOS 12, mais les tests s'exécutent sur les runners indiqués. Alpine/musl, Windows natif et les autres architectures ne disposent pas encore de paquet précompilé. Sur Windows, utiliser WSL avec une distribution Linux glibc. `PRNEXT_BINARY` reste disponible pour un binaire compatible compilé manuellement.

La sélection et les noms sont définis dans `packages/prnext/native/platforms.json`. Les versions des quatre dépendances natives doivent correspondre exactement à celle de `prnext`. L'absence d'un paquet natif provoque une erreur avec les commandes de réinstallation, sans tenter d'exécuter Cargo chez l'utilisateur. `--help` et `--version` restent disponibles.

## Préparer et tester sur la machine courante

Depuis la racine du dépôt :

```sh
npm ci
npm run release:check
npm run test:unit
npm run test:package
npm run test:package -- --nested
npm run release:verify-artifacts -- --host
```

`test:package` compile le serveur en release avec `Cargo.lock`, fabrique deux archives dans `artifacts/npm/`, puis lance un registre npm local temporaire. Il effectue une vraie installation `npm install prnext@alpha --include=optional --ignore-scripts` dans un dossier vide hors du dépôt. Les autres dépendances proviennent du registre public.

La validation contrôle les exécutables `prn`/`prnext`, l'import JavaScript du framework, la migration sans lien `file:`, le build App/Pages, CSS, les imports et métadonnées d'images, SSR, cookies, headers, query params, Flight, API GET/POST, une route Edge, l'export standalone déplacé, le rebuild en dev et le message d'erreur en cas de dépendance native absente. L'option `--nested` répète ces contrôles avec les dépendances imbriquées (`npm --install-strategy=nested`), pour détecter les résolutions qui reposent accidentellement sur le regroupement des dépendances. Les rapports `verified-<plateforme>.json` et `verified-<plateforme>-nested.json` contiennent les contrôles réussis et les empreintes des archives réellement testées. Ce test n'utilise ni `npm link`, ni `NODE_PATH`, ni `PRNEXT_BINARY` dans le consommateur.

Il ne valide que la plateforme hôte. Pour les autres plateformes, utiliser la CI ci-dessous. Les archives locales ne contiennent aucun jeton npm, log, rapport de benchmark, fichier `.env` ou test.

## Construire les quatre distributions

Après avoir envoyé le code sur GitHub, ouvrir **Actions → Verify npm alpha artifacts → Run workflow**. Le workflow `.github/workflows/npm-artifacts.yml` construit et teste chaque architecture sur son runner, puis expose les archives téléchargeables. Il ne publie rien et n'utilise aucun secret npm.

Les runners correspondent aux [environnements GitHub documentés](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). Dans un dépôt privé, leur utilisation relève du quota de minutes du compte.

Attendre que les quatre jobs réussissent. Rassembler dans `artifacts/npm/` les quatre archives natives, l'archive JavaScript `prnext-<version>.tgz` et les huit rapports associés. L'archive JavaScript doit être identique dans les quatre résultats. Une validation locale sur Mac ne prouve pas que les trois autres distributions fonctionnent. Vérifier les empreintes de tous les fichiers avant publication :

```sh
npm run release:verify-artifacts
```

Le contrôle refuse une archive remplacée depuis ses tests, un rapport manquant ou provenant d'une autre version. Il ne suffit pas de reprendre d'anciens rapports contenant le même numéro de version.

## Publier dans le bon ordre

La publication est manuelle. Vérifier les noms npm et les droits de publication sur `prnext` et sur ses quatre paquets natifs. Vérifier aussi la licence de distribution souhaitée et les informations du README ; aucun choix de licence n'est effectué automatiquement.

Activer la 2FA du compte, puis :

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

Depuis le dossier `artifacts/npm/` où les archives validées ont été rassemblées, pour la version initiale :

```sh
npm publish ./prnext-darwin-arm64-0.1.0-alpha.1.tgz --tag alpha --access public
npm publish ./prnext-darwin-x64-0.1.0-alpha.1.tgz --tag alpha --access public
npm publish ./prnext-linux-arm64-gnu-0.1.0-alpha.1.tgz --tag alpha --access public
npm publish ./prnext-linux-x64-gnu-0.1.0-alpha.1.tgz --tag alpha --access public
```

Puis, depuis la racine du checkout correspondant exactement aux archives :

```sh
node packages/prnext/release/verify.mjs
```

Ce contrôle interroge le registre public et refuse de poursuivre si une version native manque ou si ses métadonnées de plateforme sont incohérentes. Il est aussi exécuté par `prepublishOnly` lors d'une publication du workspace. Lorsqu'on publie directement une archive, exécuter le contrôle explicitement : les hooks du répertoire source ne doivent pas être supposés actifs.

Revenir dans `artifacts/npm/` puis publier l'archive JavaScript déjà testée :

```sh
npm publish ./prnext-0.1.0-alpha.1.tgz --tag alpha --access public
npm view prnext@alpha version optionalDependencies --registry=https://registry.npmjs.org/
```

Ne pas publier le monorepo racine. Il reste `private: true`. Le paquet public est `packages/prnext`. Les [tags npm](https://docs.npmjs.com/adding-dist-tags-to-packages/) distinguent `alpha` de `latest` ; ils ne rendent pas le paquet privé.

## Installation chez les testeurs

Dans leur application :

```sh
npm install prnext@alpha
npx --no-install prn check
npx --no-install prn dev
```

La compatibilité React/RSC est stricte : `react`, `react-dom` et `react-server-dom-webpack` sont des peers de même version exacte, visibles depuis l'application. npm moderne les installe automatiquement si elles sont absentes ; une application utilisant des versions incompatibles doit les aligner. Pour une migration préparant les scripts et l'alignement des versions, depuis un projet compatible :

```sh
npx --yes --package=prnext@alpha prn migrate --dry-run
npx --yes --package=prnext@alpha prn migrate
```

Ne pas utiliser `--omit=optional`, `--no-optional` ni recopier `node_modules` entre machines. Si le gestionnaire omet le binaire, `npm install --include=optional` ou l'installation explicite du paquet natif de même version permet de le récupérer. Un test d'installation neuve depuis le registre public est à refaire après publication.

## Alpha suivante

Incrémenter ensemble la version du paquet `prnext`, ses quatre `optionalDependencies`, la version racine et celle de `crates/prnext/Cargo.toml`. Actualiser `package-lock.json` avec `npm install` et `Cargo.lock` avec Cargo, puis refaire les builds et validations. Le CLI lit maintenant sa version dans `package.json`. Ne jamais réutiliser une version déjà publiée. Le tag de publication par défaut reste `alpha`.
