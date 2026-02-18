using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.UI;
#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif

public sealed class MatrixGameRuntime : MonoBehaviour
{
    private const float TargetWidth = 1240f;
    private const float TargetHeight = 1080f;
    private const int GridCols = 4;
    private const int GridRows = 4;
    private const int CardCount = GridCols * GridRows;
    private const int PairCount = CardCount / 2;

    private enum GamePhase
    {
        Playing,
        Won
    }

    [Serializable]
    private sealed class CardState
    {
        public int Id;
        public int PairId;
        public bool Revealed;
        public bool Matched;
    }

    [Serializable]
    private sealed class RoundPayload
    {
        public string action = "submitRound";
        public int turnsUsed;
        public int pairsFound;
        public bool completed;
        public int solveMs;
        public int pointsDelta;
    }

    [Serializable]
    private sealed class BackendAck
    {
        public bool ok;
        public bool accepted;
        public string error;
    }

    private sealed class CardView
    {
        public Button Button;
        public Image Face;
        public Text Glyph;
    }

    private readonly List<CardState> _deck = new List<CardState>(CardCount);
    private readonly List<int> _selectedCards = new List<int>(2);
    private readonly Dictionary<int, CardView> _cards = new Dictionary<int, CardView>(CardCount);

    private GamePhase _phase = GamePhase.Playing;
    private int _turnsUsed;
    private int _actions;
    private int _pairsFound;
    private bool _busy;
    private int _cursorIndex;
    private float _roundStartTime;

    private Text _statusText;
    private Text _progressText;
    private Text _scoreText;
    private RectTransform _gridRect;
    private GridLayoutGroup _grid;

    [Header("Backend")]
    [SerializeField] private bool useBackend = true;
    [SerializeField] private string backendBaseUrl = "http://localhost:3000";

    private static readonly Color HiddenColor = new Color(0.10f, 0.13f, 0.20f, 1f);
    private static readonly Color CursorColor = new Color(1f, 1f, 1f, 0.35f);
    private static readonly Color MatchedColor = new Color(0.18f, 0.22f, 0.30f, 1f);

    private static readonly Color[] PairColors =
    {
        ParseHex("#ff7aa2"),
        ParseHex("#ffaf66"),
        ParseHex("#ffe27a"),
        ParseHex("#91ffb2"),
        ParseHex("#79f5ff"),
        ParseHex("#8ea7ff"),
        ParseHex("#d29eff"),
        ParseHex("#ff8be8"),
    };

    private static readonly string[] PairGlyphs = { "A", "B", "C", "D", "E", "F", "G", "H" };

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
    private static void Bootstrap()
    {
        if (FindObjectOfType<MatrixGameRuntime>() != null)
        {
            return;
        }

        var go = new GameObject("MatrixGameRuntime");
        DontDestroyOnLoad(go);
        go.AddComponent<MatrixGameRuntime>();
    }

    private void Start()
    {
        BuildUi();
        StartRound();
    }

    private void Update()
    {
        UpdateGridSizing();

        if (IsRestartPressed())
        {
            StartRound();
            return;
        }

        if (_busy || _phase != GamePhase.Playing)
        {
            return;
        }

        if (IsLeftPressed()) MoveCursor(-1, 0);
        if (IsRightPressed()) MoveCursor(1, 0);
        if (IsUpPressed()) MoveCursor(0, -1);
        if (IsDownPressed()) MoveCursor(0, 1);
        if (IsConfirmPressed()) TrySelectCard(_cursorIndex);
    }

    private void StartRound()
    {
        _phase = GamePhase.Playing;
        _turnsUsed = 0;
        _actions = 0;
        _pairsFound = 0;
        _busy = false;
        _cursorIndex = 0;
        _selectedCards.Clear();
        _roundStartTime = Time.realtimeSinceStartup;

        _deck.Clear();
        var pairIds = new List<int>(CardCount);
        for (var i = 0; i < PairCount; i++)
        {
            pairIds.Add(i);
            pairIds.Add(i);
        }

        Shuffle(pairIds);

        for (var i = 0; i < CardCount; i++)
        {
            _deck.Add(new CardState
            {
                Id = i,
                PairId = pairIds[i],
                Revealed = false,
                Matched = false,
            });
        }

        SetStatus("ROUND ACTIVE. PRESS ARROWS + ENTER/SPACE.");
        RefreshUi();
    }

    private void BuildUi()
    {
        var canvasGo = new GameObject("Canvas", typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
        var canvas = canvasGo.GetComponent<Canvas>();
        canvas.renderMode = RenderMode.ScreenSpaceOverlay;

        var scaler = canvasGo.GetComponent<CanvasScaler>();
        scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.referenceResolution = new Vector2(TargetWidth, TargetHeight);
        scaler.matchWidthOrHeight = 0.5f;

        EnsureEventSystem();

        var root = CreateRect("Root", canvasGo.transform, anchorMin: Vector2.zero, anchorMax: Vector2.one, offsetMin: Vector2.zero, offsetMax: Vector2.zero);

        var panel = CreateRect("GamePanel", root, anchorMin: Vector2.zero, anchorMax: Vector2.one, offsetMin: Vector2.zero, offsetMax: Vector2.zero);
        panel.gameObject.AddComponent<Image>().color = new Color(0.07f, 0.09f, 0.14f, 0.92f);

        panel.gameObject.AddComponent<VerticalLayoutGroup>();
        var panelLayout = panel.GetComponent<VerticalLayoutGroup>();
        panelLayout.spacing = 2f;
        panelLayout.padding = new RectOffset(4, 4, 4, 4);
        panelLayout.childControlHeight = true;
        panelLayout.childControlWidth = true;
        panelLayout.childForceExpandHeight = false;

        _statusText = CreateText("Status", panel, "...", 14, TextAnchor.MiddleCenter);
        _progressText = CreateText("Progress", panel, "", 12, TextAnchor.MiddleCenter);
        _scoreText = CreateText("Score", panel, "", 12, TextAnchor.MiddleCenter);

        _gridRect = CreateRect("Grid", panel, anchorMin: new Vector2(0f, 0f), anchorMax: new Vector2(1f, 1f), offsetMin: Vector2.zero, offsetMax: Vector2.zero);
        var layout = _gridRect.gameObject.AddComponent<LayoutElement>();
        layout.flexibleHeight = 1f;
        layout.minHeight = 200f;

        _grid = _gridRect.gameObject.AddComponent<GridLayoutGroup>();
        _grid.constraint = GridLayoutGroup.Constraint.FixedColumnCount;
        _grid.constraintCount = GridCols;
        _grid.spacing = new Vector2(8f, 8f);
        _grid.childAlignment = TextAnchor.MiddleCenter;
        _grid.cellSize = new Vector2(64f, 64f);

        for (var i = 0; i < CardCount; i++)
        {
            var buttonObj = new GameObject($"Card_{i}", typeof(RectTransform), typeof(Image), typeof(Button), typeof(Outline));
            buttonObj.transform.SetParent(_gridRect, false);

            var image = buttonObj.GetComponent<Image>();
            image.color = HiddenColor;

            var outline = buttonObj.GetComponent<Outline>();
            outline.effectColor = new Color(1f, 1f, 1f, 0f);
            outline.effectDistance = new Vector2(4f, -4f);

            var button = buttonObj.GetComponent<Button>();
            var index = i;
            button.onClick.AddListener(() => TrySelectCard(index));

            var label = CreateText("Glyph", buttonObj.transform, "?", 56, TextAnchor.MiddleCenter);
            label.raycastTarget = false;

            _cards[index] = new CardView
            {
                Button = button,
                Face = image,
                Glyph = label,
            };
        }

        UpdateGridSizing();
    }

    private void TrySelectCard(int cardIndex)
    {
        if (_phase != GamePhase.Playing || _busy || _selectedCards.Count >= 2) return;
        if (cardIndex < 0 || cardIndex >= _deck.Count) return;

        var card = _deck[cardIndex];
        if (card.Matched || card.Revealed) return;

        card.Revealed = true;
        _selectedCards.Add(cardIndex);
        _actions += 1;
        RefreshUi();

        if (_selectedCards.Count == 2)
        {
            StartCoroutine(ResolveSelectedCards());
        }
    }

    private IEnumerator ResolveSelectedCards()
    {
        _busy = true;
        var a = _selectedCards[0];
        var b = _selectedCards[1];
        var isMatch = _deck[a].PairId == _deck[b].PairId;

        if (!isMatch)
        {
            SetStatus("NO MATCH. MEMORIZE THE CARDS...");
            yield return new WaitForSeconds(1.4f);
            _deck[a].Revealed = false;
            _deck[b].Revealed = false;
            SetStatus("NO MATCH. TRY AGAIN.");
        }
        else
        {
            _deck[a].Matched = true;
            _deck[b].Matched = true;
            _pairsFound += 1;
            SetStatus("MATCH (LOCAL CHECK).");
        }

        _selectedCards.Clear();
        _turnsUsed += 1;
        _busy = false;

        if (_pairsFound >= PairCount)
        {
            _phase = GamePhase.Won;
            SetStatus("CLEAR. PRESS R TO RESTART.");
            if (useBackend)
            {
                StartCoroutine(SubmitRoundToBackend());
            }
        }

        RefreshUi();
    }

    private IEnumerator SubmitRoundToBackend()
    {
        var payload = new RoundPayload
        {
            turnsUsed = _turnsUsed,
            pairsFound = _pairsFound,
            completed = _phase == GamePhase.Won,
            solveMs = Mathf.RoundToInt((Time.realtimeSinceStartup - _roundStartTime) * 1000f),
            pointsDelta = ComputeScore(),
        };

        var json = JsonUtility.ToJson(payload);
        var bytes = Encoding.UTF8.GetBytes(json);
        var url = backendBaseUrl.TrimEnd('/') + "/api/unity";

        using (var request = new UnityWebRequest(url, "POST"))
        {
            request.uploadHandler = new UploadHandlerRaw(bytes);
            request.downloadHandler = new DownloadHandlerBuffer();
            request.SetRequestHeader("Content-Type", "application/json");
            yield return request.SendWebRequest();

            if (request.result == UnityWebRequest.Result.Success)
            {
                var responseBody = request.downloadHandler.text;
                var ack = JsonUtility.FromJson<BackendAck>(responseBody);
                if (ack != null && ack.ok)
                {
                    SetStatus("CLEAR. RESULT SUBMITTED TO BACKEND.");
                }
                else
                {
                    SetStatus("CLEAR. BACKEND RESPONSE INVALID.");
                }
            }
            else
            {
                SetStatus("CLEAR. BACKEND SUBMIT FAILED.");
                Debug.LogWarning("[MatrixGameRuntime] backend submit failed: " + request.error);
            }
        }

        RefreshUi();
    }

    private void MoveCursor(int dx, int dy)
    {
        var row = _cursorIndex / GridCols;
        var col = _cursorIndex % GridCols;

        var nextRow = (row + dy + GridRows) % GridRows;
        var nextCol = (col + dx + GridCols) % GridCols;
        _cursorIndex = nextRow * GridCols + nextCol;
        RefreshUi();
    }

    private void RefreshUi()
    {
        _progressText.text = $"P {_pairsFound}/{PairCount} | T {_turnsUsed} | A {_actions}";
        _scoreText.text = $"SCORE: {ComputeScore()}";

        for (var i = 0; i < CardCount; i++)
        {
            var card = _deck[i];
            var view = _cards[i];
            var showFace = card.Revealed || card.Matched || _phase == GamePhase.Won;

            view.Face.color = card.Matched
                ? MatchedColor
                : showFace
                    ? PairColors[card.PairId % PairColors.Length]
                    : HiddenColor;

            view.Glyph.text = showFace ? PairGlyphs[card.PairId % PairGlyphs.Length] : "?";

            var outline = view.Button.GetComponent<Outline>();
            outline.effectColor = i == _cursorIndex ? CursorColor : new Color(1f, 1f, 1f, 0f);
        }
    }

    private int ComputeScore()
    {
        var turnPenalty = _turnsUsed * 26;
        var actionPenalty = _actions * 8;
        var pairBonus = _pairsFound * 80;
        var clearBonus = _phase == GamePhase.Won ? 1800 : 0;
        return Mathf.Max(0, clearBonus + pairBonus - turnPenalty - actionPenalty);
    }

    private void SetStatus(string message)
    {
        _statusText.text = message;
    }

    private static void Shuffle<T>(IList<T> list)
    {
        var rng = new System.Random();
        for (var i = list.Count - 1; i > 0; i--)
        {
            var j = rng.Next(i + 1);
            (list[i], list[j]) = (list[j], list[i]);
        }
    }

    private static RectTransform CreateRect(
        string name,
        Transform parent,
        Vector2 anchorMin,
        Vector2 anchorMax,
        Vector2 offsetMin,
        Vector2 offsetMax)
    {
        var go = new GameObject(name, typeof(RectTransform));
        go.transform.SetParent(parent, false);
        var rect = go.GetComponent<RectTransform>();
        rect.anchorMin = anchorMin;
        rect.anchorMax = anchorMax;
        rect.offsetMin = offsetMin;
        rect.offsetMax = offsetMax;
        return rect;
    }

    private static Text CreateText(string name, Transform parent, string content, int size, TextAnchor alignment)
    {
        var go = new GameObject(name, typeof(RectTransform), typeof(Text), typeof(LayoutElement));
        go.transform.SetParent(parent, false);
        var text = go.GetComponent<Text>();
        text.text = content;
        text.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
        text.fontSize = size;
        text.alignment = alignment;
        text.color = Color.white;

        var layout = go.GetComponent<LayoutElement>();
        layout.minHeight = size + 8f;
        layout.preferredHeight = size + 12f;

        return text;
    }

    private static void EnsureEventSystem()
    {
        var existing = FindObjectOfType<UnityEngine.EventSystems.EventSystem>();
        if (existing != null) return;

        var go = new GameObject("EventSystem", typeof(UnityEngine.EventSystems.EventSystem), typeof(UnityEngine.EventSystems.StandaloneInputModule));
        DontDestroyOnLoad(go);
    }

    private static Color ParseHex(string hex)
    {
        if (ColorUtility.TryParseHtmlString(hex, out var color))
        {
            return color;
        }

        return Color.white;
    }

    private void UpdateGridSizing()
    {
        if (_gridRect == null || _grid == null)
        {
            return;
        }

        var width = _gridRect.rect.width;
        var height = _gridRect.rect.height;
        if (width <= 0f || height <= 0f)
        {
            return;
        }

        var spacingX = _grid.spacing.x;
        var spacingY = _grid.spacing.y;
        var totalSpacingX = spacingX * (GridCols - 1);
        var totalSpacingY = spacingY * (GridRows - 1);

        var cellW = Mathf.Floor((width - totalSpacingX) / GridCols);
        var cellH = Mathf.Floor((height - totalSpacingY) / GridRows);
        if (cellW < 8f) cellW = 8f;
        if (cellH < 8f) cellH = 8f;

        _grid.cellSize = new Vector2(cellW, cellH);
        _grid.padding = new RectOffset(0, 0, 0, 0);
    }

    private static bool IsRestartPressed()
    {
#if ENABLE_INPUT_SYSTEM
        var keyboard = Keyboard.current;
        return keyboard != null && keyboard.rKey.wasPressedThisFrame;
#else
        return UnityEngine.Input.GetKeyDown(KeyCode.R);
#endif
    }

    private static bool IsLeftPressed()
    {
#if ENABLE_INPUT_SYSTEM
        var keyboard = Keyboard.current;
        return keyboard != null && keyboard.leftArrowKey.wasPressedThisFrame;
#else
        return UnityEngine.Input.GetKeyDown(KeyCode.LeftArrow);
#endif
    }

    private static bool IsRightPressed()
    {
#if ENABLE_INPUT_SYSTEM
        var keyboard = Keyboard.current;
        return keyboard != null && keyboard.rightArrowKey.wasPressedThisFrame;
#else
        return UnityEngine.Input.GetKeyDown(KeyCode.RightArrow);
#endif
    }

    private static bool IsUpPressed()
    {
#if ENABLE_INPUT_SYSTEM
        var keyboard = Keyboard.current;
        return keyboard != null && keyboard.upArrowKey.wasPressedThisFrame;
#else
        return UnityEngine.Input.GetKeyDown(KeyCode.UpArrow);
#endif
    }

    private static bool IsDownPressed()
    {
#if ENABLE_INPUT_SYSTEM
        var keyboard = Keyboard.current;
        return keyboard != null && keyboard.downArrowKey.wasPressedThisFrame;
#else
        return UnityEngine.Input.GetKeyDown(KeyCode.DownArrow);
#endif
    }

    private static bool IsConfirmPressed()
    {
#if ENABLE_INPUT_SYSTEM
        var keyboard = Keyboard.current;
        return keyboard != null &&
               (keyboard.enterKey.wasPressedThisFrame || keyboard.spaceKey.wasPressedThisFrame);
#else
        return UnityEngine.Input.GetKeyDown(KeyCode.Return) || UnityEngine.Input.GetKeyDown(KeyCode.Space);
#endif
    }
}
