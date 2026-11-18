"""Протокол WebSocket /ws (версия 1).

Клиент -> сервер
  text   {"type":"hello", "v":1, "platform":"web", "scene":"outdoor", "hfov":65}
         первое сообщение после подключения
  text   {"type":"config", "scene":"indoor", "hfov":70}
         смена настроек на лету (все поля необязательны)
  text   {"type":"pose", "up":[0.05, -0.97, -0.24]}
         (необязательно) ориентация телефона для следующего кадра: "вверх" в осях камеры.
         Без неё наклон телефона оценивается по полу — медленнее и не всегда.
  binary [uint32 big-endian seq][JPEG]
         кадр. Клиент шлёт следующий кадр только после ответа на предыдущий.

Сервер -> клиент
  text   {"type":"ready", "v":1, "session":"…", "max_width":640}
  text   {"type":"result", "seq":42, "obstacles":[…], "groups":[…], "hints":[…],
          "server_ms":65.3, "dropped":0}
         obstacle: {"id":6, "kind":"person|vehicle|animal|obstacle", "cls":"person",
                    "zone":"left|center|right", "pan":-0.4, "bearing":-12.5, "distance":3.2,
                    "in_path":true, "approach":1.1, "own_speed":0.1, "ttc":2.9,
                    "moving":false, "threat":true, "primary":true,
                    "alert":"danger|warn|info|none",
                    "urgency":"high|medium|low", "conf":0.8, "box":[x1,y1,x2,y2]}
         alert: danger — угроза (звук); warn — сказать голосом; info — показать; none — фон.
         group: {"type":"crowd|parking|cluster", "zones":["left","center"], "count":5, "distance":4.2}
         hints: ["too_dark", "blurry"]
         bypass: "left" | "right" — с этой стороны главную опасность можно обойти;
                 "none" — прохода в кадре не видно; null — обходить нечего
         cls у kind=obstacle: предмет по детектору (bench, chair, fire hydrant...), иначе по форме:
                 wall (стена) / pole (столб или дерево) / low (низкое), иначе obstacle
         Список отсортирован: сначала primary (главная опасность), потом угрозы, потом остальное.
         zone=center — коридор движения (в метрах), а не средняя треть кадра.
         kind=obstacle — найдено по карте глубины без класса (дерево, столб, стена...),
         id -1/-2/-3 = ближайшее препятствие слева / в коридоре / справа.
  text   {"type":"error", "message":"…"}
"""
import struct
from typing import Literal

from pydantic import BaseModel, Field

from .config import Scene
from .schemas import Bypass, Group, Hint, Obstacle

PROTOCOL_VERSION = 1
FRAME_HEADER = struct.Struct(">I")  # seq: uint32 big-endian
CLIENT_MAX_WIDTH = 640  # клиент ужимает кадр до этой ширины перед отправкой


class Hello(BaseModel):
    type: Literal["hello"]
    v: int = PROTOCOL_VERSION
    platform: str = "unknown"
    scene: Scene | None = None
    hfov: float | None = Field(default=None, gt=20, lt=150)  # угол обзора по ДЛИННОЙ стороне кадра


class Config(BaseModel):
    type: Literal["config"]
    scene: Scene | None = None
    hfov: float | None = Field(default=None, gt=20, lt=150)


class Pose(BaseModel):
    """Ориентация телефона для СЛЕДУЮЩЕГО кадра: направление "вверх" (по гравитации)
    в координатах камеры — X вправо, Y вниз по картинке, Z вперёд от камеры.
    Телефон вертикально: [0, -1, 0]; наклонён к полу на 30°: [0, -0.87, -0.5]."""
    type: Literal["pose"]
    up: tuple[float, float, float] | None = None  # None — у телефона нет датчика ориентации
    # Курс: куда человеку нужно относительно оси камеры, градусы (> 0 правее); None — курс не задан.
    # Сторона обхода выбирается ближе к курсу.
    course: float | None = Field(default=None, ge=-180, le=180)
    # Для записи сессии (SPATIA_RECORD=1): что делает человек и куда смотрит камера по компасу
    motion: Literal["walking", "standing", "turning", "unknown"] | None = None
    heading: float | None = None
    map: bool = False  # прислать карту местности (экран "карта" открыт)


class Ready(BaseModel):
    type: Literal["ready"] = "ready"
    v: int = PROTOCOL_VERSION
    session: str
    max_width: int = CLIENT_MAX_WIDTH


class Result(BaseModel):
    type: Literal["result"] = "result"
    seq: int
    obstacles: list[Obstacle]
    groups: list[Group] = []  # толпа / парковка
    hints: list[Hint] = []  # подсказки по кадру: too_dark, blurry
    bypass: Bypass | None = None  # с какой стороны обойти главную опасность (none — прохода не видно)
    # Карта местности (если клиент просит, pose.map=true): занятые клетки, маршрут, люди — в метрах
    # относительно человека, в осях мира (x — "восток", y — "север" компаса телефона)
    map: dict | None = None
    path_bearing: float | None = None  # куда ведёт маршрут по курсу, градусы от оси камеры (> 0 — правее)
    server_ms: float
    dropped: int  # сколько кадров сервер выбросил как устаревшие (за сессию)


class Error(BaseModel):
    type: Literal["error"] = "error"
    message: str


def parse_frame(data: bytes) -> tuple[int, bytes]:
    if len(data) <= FRAME_HEADER.size:
        raise ValueError("кадр слишком короткий")
    (seq,) = FRAME_HEADER.unpack_from(data)
    return seq, data[FRAME_HEADER.size:]
