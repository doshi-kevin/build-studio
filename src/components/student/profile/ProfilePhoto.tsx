/**
 * ProfilePhoto — avatar upload with preview, crop-to-square, replace/remove.
 *
 * Uses a hidden file input + canvas for square cropping.
 * Calls server actions for upload (base64) and removal.
 *
 * Type: Client Component
 */
'use client'

import { useState, useRef, useCallback, useTransition } from 'react'
import { Camera, Trash2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { updateAvatar, removeAvatar } from '@/app/(dashboard)/student/profile/actions'

interface ProfilePhotoProps {
  avatarUrl: string | null
  initials: string
  isEditing: boolean
}

export function ProfilePhoto({ avatarUrl, initials, isEditing }: ProfilePhotoProps) {
  const [preview, setPreview] = useState<string | null>(null)
  const [currentUrl, setCurrentUrl] = useState(avatarUrl)
  const [isPending, startTransition] = useTransition()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const cropToSquare = useCallback((file: File): Promise<{ base64: string; mimeType: string }> => {
    return new Promise((resolve, reject) => {
      const img = new Image()
      const reader = new FileReader()

      reader.onload = () => {
        img.onload = () => {
          const canvas = document.createElement('canvas')
          const size = Math.min(img.width, img.height)
          canvas.width = 400
          canvas.height = 400

          const ctx = canvas.getContext('2d')
          if (!ctx) return reject(new Error('Canvas not supported'))

          const sx = (img.width - size) / 2
          const sy = (img.height - size) / 2
          ctx.drawImage(img, sx, sy, size, size, 0, 0, 400, 400)

          const mimeType = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
          const base64 = canvas.toDataURL(mimeType, 0.9)
          resolve({ base64, mimeType })
        }
        img.onerror = () => reject(new Error('Failed to load image'))
        img.src = reader.result as string
      }
      reader.onerror = () => reject(new Error('Failed to read file'))
      reader.readAsDataURL(file)
    })
  }, [])

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file')
      return
    }

    if (file.size > 5 * 1024 * 1024) {
      toast.error('Image must be under 5 MB')
      return
    }

    try {
      const { base64, mimeType } = await cropToSquare(file)
      setPreview(base64)

      startTransition(async () => {
        const result = await updateAvatar(base64, mimeType)
        if (result.error) {
          toast.error(result.error)
          setPreview(null)
        } else {
          toast.success('Avatar updated')
          setCurrentUrl(result.avatarUrl || base64)
          setPreview(null)
        }
      })
    } catch {
      toast.error('Failed to process image')
    }

    // Reset input so re-selecting same file triggers change
    e.target.value = ''
  }

  const handleRemove = () => {
    startTransition(async () => {
      const result = await removeAvatar()
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success('Avatar removed')
        setCurrentUrl(null)
        setPreview(null)
      }
    })
  }

  const displayUrl = preview || currentUrl

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative">
        <Avatar className="h-24 w-24">
          {displayUrl && <AvatarImage src={displayUrl} alt="Profile photo" />}
          <AvatarFallback className="text-2xl font-semibold">{initials}</AvatarFallback>
        </Avatar>

        {isPending && (
          <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40">
            <Loader2 className="h-6 w-6 animate-spin text-white" />
          </div>
        )}
      </div>

      {isEditing && (
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={isPending}
          >
            <Camera className="h-3.5 w-3.5 mr-1.5" />
            {currentUrl ? 'Change' : 'Upload'}
          </Button>

          {currentUrl && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRemove}
              disabled={isPending}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
              Remove
            </Button>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            onChange={handleFileSelect}
          />
        </div>
      )}
    </div>
  )
}
