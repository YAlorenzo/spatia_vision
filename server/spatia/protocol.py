"""Протокол WebSocket /ws (версия 1).

Клиент -> сервер
  text   {"type":"hello", "v":1, "platform":"web", "scene":"outdoor", "hfov":65}
         первое сообщение после подключения
  text   {"type":"config", "scene":"indoor", "hfov":70}
         смена настроек на лету (все поля необязательны)
  binary [uint32 big-endian seq][JPEG]
         кадр. Клиент шлёт следующий кадр только после ответа на предыдущий.

Сервер -> клиент
  text   {"type":"ready", "v":1, "session":"…", "max_width":640}
  text   {"type":"result", "seq":42, "obstacles":[…], "server_ms":65.3, "dropped":0}
         obstacle: {"id":6, "kind":"person|vehicle|animal|obstacle", "cls":"person",
                    "zone":"left|center|right", "pan":-0.4, "bearing":-12.5, "distance":3.2,
                    "in_path":true, "approach":1.1, "own_speed":0.1, "ttc":2.9,
                    "moving":false, "threat":true, "primary":true,
                    "urgency":"high|medium|low", "conf":0.8, "box":[x1,y1,x2,y2]}
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
from .schemas import Obstacle

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


class Ready(BaseModel):
    type: Literal["ready"] = "ready"
    v: int = PROTOCOL_VERSION
    session: str
    max_width: int = CLIENT_MAX_WIDTH


class Result(BaseModel):
    type: Literal["result"] = "result"
    seq: int
    obstacles: list[Obstacle]
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
