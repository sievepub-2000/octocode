<p align="center">
          <a href="https://marketplace.visualstudio.com/items?itemName=OctoCode.octocode"><img src="https://img.shields.io/badge/VS_Code_Marketplace-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace"></a>
          <a href="https://x.com/OctoCodeDev"><img src="https://img.shields.io/badge/OctoCode-000000?style=flat&logo=x&logoColor=white" alt="X"></a>
          <a href="https://discord.gg/VxfP4Vx3gX"><img src="https://img.shields.io/badge/Join%20Discord-5865F2?style=flat&logo=discord&logoColor=white" alt="Join Discord"></a>
          <a href="https://www.reddit.com/r/OctoCode/"><img src="https://img.shields.io/badge/Join%20r%2FOctoCode-FF4500?style=flat&logo=reddit&logoColor=white" alt="Join r/OctoCode"></a>
          <a href="https://github.com/OctoCode-Org/OctoCode/issues"><img src="https://img.shields.io/badge/GitHub-Issues-181717?style=flat&logo=github&logoColor=white" alt="GitHub Issues"></a>
        </p>
        <p align="center">
          <em>Szybko uzyskaj pomoc → <a href="https://discord.gg/VxfP4Vx3gX">Dołącz do Discorda</a> • Wolisz asynchronicznie? → <a href="https://www.reddit.com/r/OctoCode/">Dołącz do r/OctoCode</a></em>
        </p>

        # OctoCode

        > Twój zespół deweloperski zasilany AI — prosto w edytorze

        ## Jesteśmy OctoCode

> OctoCode kontynuuje rozwój tego projektu po tym, jak zespół Roo zakończył
> aktywny rozwój Roo Code, aby skupić się na [Roomote](https://roomote.dev/).
> Dziękujemy zespołowi Roo za wszystko, co stworzyli.
>
> Główny zespół to grupa deweloperów, którzy wcześniej współtworzyli Roo i
> naprawdę zależy im na tej wtyczce. Będziemy dalej aktualizować modele,
> naprawiać błędy i wydawać nowe funkcje, i zamierzamy uważnie słuchać
> społeczności, która uczyniła tę wtyczkę tak wyjątkową. Dołącz do nas na
> [Discordzie](https://discord.gg/VxfP4Vx3gX),
> [Reddicie](https://www.reddit.com/r/OctoCode), albo
> [otwórz PR lub issue](https://github.com/OctoCode-Org/OctoCode).
>
> _-OctoCode Team_

## Migracja z Roo Code do OctoCode

Szybki przewodnik po przejściu z Roo Code do OctoCode znajdziesz w [przewodniku migracji Roo→OctoCode](https://docs.octocode.dev/roo-to-octocode-migration). Chcemy jak najlepiej pomagać użytkownikom w czasie przejścia i właśnie do tego służą nasze [Reddit](https://www.reddit.com/r/OctoCode) oraz [Discord](https://discord.gg/VxfP4Vx3gX). Jeśli masz problem albo pytanie, wpadaj i pytaj.

## Co OctoCode dodał od czasu Roo Code

OctoCode rozwija fundament stworzony przez Roo Code i stale rozszerza go o:

- **Analizę bazy kodu Semble** — szybkie, semantyczne wyszukiwanie kodu na żądanie, z automatyczną konfiguracją i bez osobnego procesu indeksowania.
- **Silniejsze workflow Orchestratora** — bezpieczniejsze delegowanie, równoległą koordynację zadań, niezawodne odzyskiwanie zadań nadrzędnych i podrzędnych oraz lepszą izolację między podzadaniami a profilami providerów.
- **Dłuższe autonomiczne działanie z Destructive Command Guard (DCG)** — automatyczne blokowanie niebezpiecznych poleceń przy jednoczesnym kontynuowaniu zaufanej pracy bez wielokrotnych próśb o zatwierdzenie.
- **Najnowsze modele** — stałe wsparcie dla nowych rodzin modeli Claude, GPT, Gemini, Kimi, GLM, Grok, MiniMax i innych.
- **Więcej sposobów łączenia** — nowych i rozszerzonych providerów, w tym OctoCode Gateway, Moonshot, Kimi Code, Kenari, Friendli, OpenCode Go i wielu innych.
- **Bardziej niezawodne workflow terminala i edycji** — poprawki przedwczesnego kończenia poleceń terminala, race condition stanu zadań, zarządzania kontekstem, edycji diff i użycia narzędzi właściwych dla providerów.
- **Większą kontrolę nad workspace** — zarządzanie regułami, ograniczenia MCP dla poszczególnych trybów, kontrolę ścieżek multi-root, opcje reasoning modeli i akcje przeglądu zmian po ukończeniu.

## Nowości w v3.78.0

- **Pojawiły się trzy ważne nowe modele** — korzystaj z zupełnie nowych Gemini 3.7 Flash, GLM 5.3 i Qwen3.8 Max oraz zaktualizowanego reasoning, cen i obsługi providerów dla DeepSeek V4.
- **Połącz się z NanoGPT** — korzystaj z dynamicznego wykrywania modeli, streamingu i uzupełniania promptów oraz preferencji routingu według szybkości, ceny, opóźnienia, przepustowości, obsługi narzędzi i cache.
- **Bardziej niezawodni providerzy i zadania** — poprawki usprawniają konfigurację endpointów Azure OpenAI, limity wyjścia Kimi Code, zachowywanie tytułów historii zadań oraz import/eksport ustawień OctoCode.
- Destructive Command Guard obsługuje teraz komputery Mac z procesorami Intel.
- Aktualizacje zabezpieczeń usuwają luki w `undici` i Mermaid.

## Co OctoCode może zrobić dla CIEBIE?

- Generowanie kodu z opisów w języku naturalnym
- Dostosuj się za pomocą trybów: Kod, Architekt, Zapytaj, Debugowanie i Tryby niestandardowe
- Refaktoryzacja i debugowanie istniejącego kodu
- Pisanie i aktualizowanie dokumentacji
- Odpowiadanie na pytania dotyczące Twojej bazy kodu
- Automatyzacja powtarzalnych zadań
- Wykorzystanie serwerów MCP

## Tryby

OctoCode dostosowuje się do Twojego sposobu pracy, a nie odwrotnie:

- Tryb Kod: codzienne kodowanie, edycje i operacje na plikach
- Tryb Architekt: planowanie systemów, specyfikacji i migracji
- Tryb Zapytaj: szybkie odpowiedzi, wyjaśnienia i dokumenty
- Tryb Debugowanie: śledzenie problemów, dodawanie logów, izolowanie przyczyn źródłowych
- Tryby niestandardowe: buduj specjalistyczne tryby dla swojego zespołu lub przepływu pracy

Więcej: [Korzystanie z trybów](https://docs.octocode.dev/basic-usage/using-modes) • [Tryby niestandardowe](https://docs.octocode.dev/advanced-usage/custom-modes)

## Zasoby

- **[Dokumentacja](https://docs.octocode.dev):** Oficjalny przewodnik po instalacji, konfiguracji i opanowaniu OctoCode.
- **[Serwer Discord](https://discord.gg/VxfP4Vx3gX):** Dołącz do społeczności, aby uzyskać pomoc i dyskutować w czasie rzeczywistym.
- **[Społeczność Reddit](https://www.reddit.com/r/OctoCode):** Dziel się swoimi doświadczeniami i zobacz, co budują inni.
- **[Problemy na GitHub](https://github.com/OctoCode-Org/OctoCode/issues):** Zgłaszaj błędy i śledź rozwój.
- **[Prośby o funkcje](https://github.com/OctoCode-Org/OctoCode/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop):** Masz pomysł? Podziel się nim z deweloperami.

---

## Konfiguracja lokalna i programowanie

1. **Sklonuj** repozytorium:

```sh
git clone https://github.com/OctoCode-Org/OctoCode.git
```

2. **Zainstaluj zależności**:

```sh
pnpm install
```

3. **Uruchom rozszerzenie**:

Istnieje kilka sposobów na uruchomienie rozszerzenia OctoCode:

### Tryb deweloperski (F5)

Do aktywnego programowania użyj wbudowanego debugowania VSCode:

Naciśnij `F5` (lub przejdź do **Uruchom** → **Rozpocznij debugowanie**) w VSCode. Otworzy to nowe okno VSCode z uruchomionym rozszerzeniem OctoCode.

- Zmiany w widoku internetowym pojawią się natychmiast.
- Zmiany w rdzeniu rozszerzenia również zostaną automatycznie przeładowane na gorąco.

### Zautomatyzowana instalacja VSIX

Aby zbudować i zainstalować rozszerzenie jako pakiet VSIX bezpośrednio w VSCode:

```sh
pnpm install:vsix [-y] [--editor=<command>]
```

To polecenie:

- Zapyta, którego polecenia edytora użyć (code/cursor/code-insiders) - domyślnie 'code'
- Odinstaluje każdą istniejącą wersję rozszerzenia.
- Zbuduje najnowszy pakiet VSIX.
- Zainstaluje nowo zbudowany VSIX.
- Poprosi o ponowne uruchomienie VS Code w celu wprowadzenia zmian.

Opcje:

- `-y`: Pomiń wszystkie monity o potwierdzenie i użyj wartości domyślnych
- `--editor=<command>`: Określ polecenie edytora (np. `--editor=cursor` lub `--editor=code-insiders`)

### Ręczna instalacja VSIX

Jeśli wolisz zainstalować pakiet VSIX ręcznie:

1.  Najpierw zbuduj pakiet VSIX:
    ```sh
    pnpm vsix
    ```
2.  Plik `.vsix` zostanie wygenerowany w katalogu `bin/` (np. `bin/octocode-<version>.vsix`).
3.  Zainstaluj go ręcznie za pomocą VSCode CLI:
    ```sh
    code --install-extension bin/octocode-<version>.vsix
    ```

---

Używamy [changesets](https://github.com/changesets/changesets) do wersjonowania i publikowania. Sprawdź nasz `CHANGELOG.md`, aby uzyskać informacje o wydaniu.

---

## Zastrzeżenie

**Uwaga** OctoCode **nie** składa żadnych oświadczeń ani nie udziela żadnych gwarancji dotyczących jakiegokolwiek kodu, modeli lub innych narzędzi dostarczonych lub udostępnionych w związku z OctoCode, jakimikolwiek powiązanymi narzędziami stron trzecich ani żadnymi wynikami. Użytkownik przyjmuje na siebie **wszelkie ryzyko** związane z korzystaniem z takich narzędzi lub wyników; takie narzędzia są dostarczane na zasadzie **"TAK JAK JEST"** i **"W MIARĘ DOSTĘPNOŚCI"**. Takie ryzyko może obejmować, bez ograniczeń, naruszenie własności intelektualnej, luki w zabezpieczeniach cybernetycznych lub ataki, stronniczość, niedokładności, błędy, wady, wirusy, przestoje, utratę lub uszkodzenie mienia i/lub obrażenia ciała. Użytkownik ponosi wyłączną odpowiedzialność za korzystanie z takich narzędzi lub wyników (w tym, bez ograniczeń, za ich legalność, stosowność i wyniki).

---

## Wkład

Uwielbiamy wkłady społeczności! Zacznij od przeczytania naszego pliku [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Licencja

[Apache 2.0 © 2025 OctoCode Org](../../LICENSE)

---

**Miłego korzystania z OctoCode!** Niezależnie od tego, czy trzymasz go na krótkiej smyczy, czy pozwalasz mu działać autonomicznie, nie możemy się doczekać, żeby zobaczyć, co zbudujesz. Jeśli masz pytania albo pomysły na funkcje, otwórz [issue](https://github.com/OctoCode-Org/OctoCode/issues) albo rozpocznij [discussion](https://github.com/OctoCode-Org/OctoCode/discussions). Miłego kodowania!
